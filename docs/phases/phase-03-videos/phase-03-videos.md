---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-09T15:39:03-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-09T16:25:13-0300"
  docs/phases/phase-03-videos/context.md: "2026-07-09T16:26:59-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-09T16:26:39-0300"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-09T15:40:34-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video ingestion pipeline — resumable 10GB uploads going directly to object storage via presigned multipart URLs, automatic background processing (metadata extraction + thumbnail generation) through a BullMQ queue consumed by a dedicated FFmpeg worker container, unique short URLs per video, and streaming/download delivery served straight from storage — establishing the media foundation that Phases 04 (management) and 05 (watch page) build upon.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Compose Infrastructure (MinIO + Redis)

**Description:** Install all Phase 03 production dependencies, create the `storage` and `queue` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and add the MinIO (object storage) and Redis (queue backend) services to Docker Compose.

**Technical actions:**

- Install production dependencies in nestjs-project: `bullmq`, `@nestjs/bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nanoid@3` (v3 pinned — v4+ is ESM-only, incompatible with the CJS runtime, per TD-05 revision)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (string, default `'http://minio:9000'`), `S3_PUBLIC_ENDPOINT` (string, default `'http://localhost:9000'` — host-visible endpoint embedded in presigned URLs), `S3_REGION` (string, default `'us-east-1'`), `S3_ACCESS_KEY` (string, required), `S3_SECRET_KEY` (string, required), `S3_BUCKET` (string, default `'streamtube-videos'`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add all new environment variables to the Joi schema (`S3_ACCESS_KEY`/`S3_SECRET_KEY` required, others with defaults). Update `.env` accordingly
- Add `minio` service to `nestjs-project/compose.yaml` — image `minio/minio`, command `server /data --console-address ":9001"`, ports 9000 (S3 API) and 9001 (console), `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` env, healthcheck via `mc ready local` (or `curl http://localhost:9000/minio/health/live`), named volume for `/data`
- Add `redis` service to `nestjs-project/compose.yaml` — image `redis:7`, port 6379, healthcheck `redis-cli ping`
- Make `nestjs-api` depend on `minio` and `redis` (healthy)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | Extended schema accepts the new vars with defaults; missing `S3_ACCESS_KEY` fails validation |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `minio` and `redis` healthy alongside the existing stack
- Application starts without errors with the new environment variables; starting without `S3_ACCESS_KEY` causes a Joi validation error at bootstrap
- Existing full suite still green (no regression from dependency installs)

---

### SI-03.2 — Storage Module (S3/MinIO Client Wrapper)

**Description:** Implement the `StorageModule` with a `StorageService` that wraps the AWS SDK v3 S3 client configured for MinIO (`forcePathStyle: true`), exposing exactly the operations the phase needs: bucket bootstrap, multipart lifecycle, presigned URLs (upload parts, GET for stream/download) and object verification. This is the single place that talks to object storage (TD-07).

**Technical actions:**

- Create `src/storage/storage.module.ts` — `StorageModule` exporting `StorageService`; provider for the `S3Client` built from `storageConfig` (`endpoint`, `region`, `credentials`, `forcePathStyle: true`)
- Create `src/storage/storage.constants.ts` — key-prefix builders: `videoKey(videoId, ext)` → `videos/{videoId}/original{ext}`; `thumbnailKey(videoId)` → `thumbnails/{videoId}.jpg`; presign TTL constants (`UPLOAD_PART_URL_TTL_SECONDS = 3600`, `PLAYBACK_URL_TTL_SECONDS = 3600`)
- Create `src/storage/storage.service.ts` — `StorageService` injecting the `S3Client` and `storageConfig`. Methods (all async, explicit return types):
  - `ensureBucket(): Promise<void>` — `HeadBucketCommand` guarded `CreateBucketCommand` (idempotent; called at API/worker bootstrap and by integration tests)
  - `createMultipartUpload(key: string, contentType: string): Promise<string>` — returns `UploadId`
  - `presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string>` — `getSignedUrl` over `UploadPartCommand`, TTL 1h (TD-02 revision). Presigned URLs are signed against a client configured with `S3_PUBLIC_ENDPOINT` so they work from the host/browser
  - `completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>`
  - `abortMultipartUpload(key: string, uploadId: string): Promise<void>`
  - `headObject(key: string): Promise<{ sizeBytes: number } | null>` — null on 404/NotFound
  - `presignGetObject(key: string, opts?: { downloadFilename?: string }): Promise<string>` — `GetObjectCommand`, TTL 1h; when `downloadFilename` set, adds `ResponseContentDisposition: attachment; filename="..."` (TD-08)
  - `putObject(key: string, body: Buffer, contentType: string): Promise<void>` — used by the worker to store thumbnails
  - `deleteObject(key: string): Promise<void>` — used by cleanup

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with configured imports |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO from Compose: ensureBucket idempotent; multipart create→presign part→PUT via presigned URL (fetch)→complete→headObject returns size; presigned GET serves the object (200) and honors Range (206); abort removes pending upload; putObject/deleteObject round-trip |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Integration suite exercises the full multipart lifecycle against the real MinIO container — no storage mocks
- A presigned GET URL returns `206 Partial Content` with the correct byte slice when requested with a `Range` header
- `presignUploadPart` URLs are usable from the host (public endpoint), while SDK calls use the internal Docker endpoint

---

### SI-03.3 — Video Entity, Migration, and Videos Module Scaffold

**Description:** Create the `Video` entity linked to `Channel`, the `CreateVideos` migration, and the `VideosModule` scaffold. The entity carries the status lifecycle (TD-06), the unique `url_id` (TD-05), storage keys (TD-07) and the metadata fields fixed in TD-04's revision.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `Video` entity, table `videos`, per the Data Model below (uuid PK, `channel_id` FK, `url_id` unique, `status` PostgreSQL enum `videos_status_enum` with values `draft|processing|ready|failed` default `draft`, storage/upload columns, `duration_seconds`, `metadata` jsonb, `error_message`, timestamps). `@ManyToOne` to `Channel` with `@JoinColumn({ name: 'channel_id' })`
- Export a `VideoStatus` string enum from the entity file (same convention as `VerificationTokenType`)
- Create `src/videos/videos.module.ts` — `VideosModule` importing `TypeOrmModule.forFeature([Video])`; register in `AppModule`
- Generate migration via CLI: `npm run migration:generate -- src/database/migrations/CreateVideos` (in-container); review generated SQL (enum type + table + FK + unique/regular indexes)
- Update `src/database/migrations.integration-spec.ts` — include the new migration class in the explicit imports, `videos` in `MANAGED_TABLES`, drop of `videos_status_enum` alongside the existing enum drop, and adjust the expected table list/migration count

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Constraints: FK to channels enforced; `url_id` unique violation raises; `status` defaults to `draft`; jsonb round-trip of metadata |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles |
| `src/database/migrations.integration-spec.ts` | Integration | Migrations apply/revert including `CreateVideos` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with FK to `channels`, unique index on `url_id`, and the status enum
- Reverting the last migration drops the table and the enum type cleanly
- A `Video` row cannot exist pointing at a non-existent channel

---

### SI-03.4 — Queue Module and Processing Producer

**Description:** Register BullMQ in the application (`BullModule.forRootAsync` on the `queue` config namespace), declare the `video-processing` queue, and implement the producer service that enqueues `process-video` jobs with the retry/backoff policy fixed in TD-06.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `QueueModule` with `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })`; re-export a `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`
- Create `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `PROCESS_VIDEO_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } as const`
- Create `src/queue/video-queue.producer.ts` — `VideoQueueProducer` injecting `@InjectQueue(VIDEO_PROCESSING_QUEUE)`. Method `enqueueProcessVideo(videoId: string): Promise<void>` adding the job with the constant options and payload `{ videoId }` (minimal payload — the worker re-reads the row, keeping the job idempotent under at-least-once delivery)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.module.spec.ts` | Unit | Module compiles (Bull connection options from config) |
| `src/queue/video-queue.producer.integration-spec.ts` | Integration | Against real Redis from Compose: enqueued job lands in the `video-processing` queue with payload `{ videoId }`, `attempts: 3`, exponential backoff |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Producer writes jobs to the real Redis-backed queue (verified by reading the job back via a BullMQ `Queue` handle in the test)
- Job options carry the TD-06 retry policy (3 attempts, exponential backoff)

---

### SI-03.5 — Upload Initiation with Draft Pre-registration

**Description:** Implement upload initiation: `POST /videos/uploads` pre-registers the video as a draft (TD-06) owned by the authenticated user's channel, generates the unique `url_id` (TD-05), starts the multipart upload in storage, and returns presigned part URLs. A companion endpoint re-issues part URLs for resume/expiry (TD-02).

**Technical actions:**

- Create `src/videos/videos.constants.ts` — `MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3` (10 GiB), `UPLOAD_PART_SIZE_BYTES = 100 * 1024 ** 2` (100 MiB), `URL_ID_LENGTH = 11`, `ALLOWED_VIDEO_MIME_PREFIX = 'video/'`, `ABANDONED_UPLOAD_TTL_HOURS = 24`
- Create `src/videos/dto/initiate-upload.dto.ts` — `InitiateUploadDto`: `filename` (`@IsString() @IsNotEmpty() @MaxLength(255)`), `contentType` (`@IsString() @Matches(/^video\//)`), `sizeBytes` (`@IsInt() @IsPositive() @Max(MAX_VIDEO_SIZE_BYTES)` — the 10 GiB gate from TD-02's revision), `title` (`@IsOptional() @IsString() @MaxLength(255)`; defaults to filename without extension)
- Create `src/videos/dto/request-part-urls.dto.ts` — `RequestPartUrlsDto`: `partNumbers` (`@IsArray() @ArrayNotEmpty() @IsInt({ each: true })`, each within 1..computed part count)
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `StorageService`, `VideoQueueProducer`, `DataSource`. Implement:
  - `initiateUpload(userId: string, dto: InitiateUploadDto)` — resolve the user's channel (join via channel repository/user relation; user always has one, Phase 02 invariant); generate `url_id = nanoid(11)` with a single retry on unique-violation (TD-05); compute `storage_key` from the video id + filename extension; `createMultipartUpload`; persist draft row (status `draft`, `upload_id`, declared size, content type); compute `partCount = ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES)`; presign all part URLs; return `{ video, upload: { partSizeBytes, partCount, parts } }`
  - `requestPartUrls(userId: string, videoId: string, dto)` — load video, `NotVideoOwnerException` when the video's channel doesn't belong to the user, `UploadNotInProgressException` when status ≠ `draft` or `upload_id` null; re-presign requested part numbers (validating range)
- Create `src/videos/videos.controller.ts` — `VideosController` (`@Controller('videos')`): `@Post('uploads')` (201) and `@Post(':videoId/upload/part-urls')` (200), both authenticated (global guard — no `@Public()`), user extracted from the JWT payload as in `auth` module
- Add domain exceptions in `src/common/exceptions/domain.exception.ts`: `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `NotVideoOwnerException` (403 `NOT_VIDEO_OWNER`), `FileTooLargeException` (413 `FILE_TOO_LARGE` — defensive; DTO already gates), `UnsupportedMediaTypeException` (415 `UNSUPPORTED_MEDIA_TYPE` — defensive), `UploadNotInProgressException` (409 `UPLOAD_NOT_IN_PROGRESS`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | url_id retry on unique violation; title defaulting; part count computation; owner check branches; status guards |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO: initiate persists draft row with url_id/upload_id and opens a real multipart upload; requestPartUrls re-issues usable URLs |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/uploads` 201 with draft video + part URLs; 400 on size > 10GiB; 400 on non-video contentType; 401 without token; part-urls 403 for non-owner, 409 when no upload in progress |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos/uploads` with a valid payload returns 201 with the draft video (status `draft`, 11-char `url_id`) and presigned URLs for every part (100 MiB parts)
- Declared size above 10 GiB is rejected before any storage call (400 validation)
- The draft row exists in the DB immediately after initiation ("pré-cadastro automático")
- A second user cannot request part URLs for a video they don't own (403 `NOT_VIDEO_OWNER`)

---

### SI-03.6 — Upload Completion and Processing Enqueue

**Description:** Implement the explicit completion call (TD-03): validate ownership and upload state, complete the multipart upload in storage, verify the object landed with the declared size, flip status `draft → processing`, and enqueue the `process-video` job.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto`: `parts` (`@IsArray() @ArrayNotEmpty()`, nested `@ValidateNested({ each: true })` of `{ partNumber: @IsInt() @Min(1); etag: @IsString() @IsNotEmpty() }`)
- Implement `completeUpload(userId: string, videoId: string, dto)` in `VideosService` — load video; owner/state guards (`NotVideoOwnerException`, `UploadNotInProgressException`); `storage.completeMultipartUpload(key, uploadId, parts)`; `headObject` to verify existence and that stored size equals declared `size_bytes` (mismatch → `UploadIncompleteException`, abort + status stays `draft`); on success: set status `processing`, clear `upload_id`, save, then `videoQueueProducer.enqueueProcessVideo(video.id)` (enqueue after commit — DB status is the source of truth; a crash between save and enqueue leaves a `processing` row recoverable by re-enqueue)
- Add `UploadIncompleteException` (400 `UPLOAD_INCOMPLETE`) to the domain exceptions
- Add `@Post(':videoId/upload/complete')` (200) to `VideosController` returning `{ id, urlId, status }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Guards (owner, state); size-mismatch branch does not flip status; enqueue called exactly once after successful completion |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real MinIO + Redis + DB: upload real parts via presigned URLs, complete → object exists in storage, row flips to `processing`, job lands in the queue with the video id |
| `test/videos.e2e-spec.ts` | E2E | Full handshake with a small real file: initiate → PUT parts → complete returns 200 `{ status: 'processing' }`; 409 on double-complete; 403 non-owner |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- Completing a real multipart upload (small file, real presigned PUTs) results in the object stored in MinIO, the row in `processing`, and a job in the `video-processing` queue
- Completing twice returns 409 `UPLOAD_NOT_IN_PROGRESS`
- A declared-size mismatch aborts completion with 400 `UPLOAD_INCOMPLETE` and the video stays `draft`

---

### SI-03.7 — Video Worker: FFmpeg Processing Pipeline and Worker Container

**Description:** Implement the video worker (TD-04): a BullMQ processor that consumes `process-video` jobs, reads the source straight from storage via presigned URL, extracts duration/metadata with `ffprobe`, generates the thumbnail with `ffmpeg`, persists results and flips the status (`processing → ready | failed` per TD-06). Runs as a separate container from the same codebase via a dedicated entrypoint.

**Technical actions:**

- Create `src/worker/ffmpeg.service.ts` — `FfmpegService` spawning binaries via `child_process` (`execFile`, promisified, with timeout):
  - `probe(url: string): Promise<VideoProbeResult>` — `ffprobe -v error -print_format json -show_format -show_streams <url>`; parse duration (seconds, rounded), width/height/codec from the first video stream, format name, size
  - `captureFrame(url: string, atSecond: number): Promise<Buffer>` — `ffmpeg -ss <t> -i <url> -frames:v 1 -f image2 -c:v mjpeg pipe:1` capturing stdout as JPEG buffer
- Create `src/worker/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE) class VideoProcessor extends WorkerHost` injecting `Repository<Video>`, `StorageService`, `FfmpegService`. `process(job)`: load video by `job.data.videoId` (missing row → log and return — idempotency); presign GET for `storage_key`; `probe`; thumbnail frame at second 1 (or 10% of duration when < 10s, per TD-04 revision); `putObject` thumbnail at `thumbnails/{videoId}.jpg`; update row: `duration_seconds`, `metadata` (width, height, codec, format, size_bytes), `thumbnail_key`, status `ready`, `error_message = null`
  - `@OnWorkerEvent('failed')` handler: when `job.attemptsMade >= attempts` (final attempt), set status `failed` + persist `error_message` (background-task context: log, never rethrow — per nestjs-services rule)
- Create `src/worker/worker.module.ts` — `WorkerModule` importing `ConfigModule.forRoot({ isGlobal: true, load: [...] , validationSchema })`, `TypeOrmModule.forRootAsync` (same `databaseConfig` factory), `QueueModule` pieces (`BullModule.forRootAsync` + `registerQueue`), `StorageModule`; providers `FfmpegService`, `VideoProcessor`
- Create `src/worker-main.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `app.enableShutdownHooks()` (graceful shutdown lets in-flight jobs finish)
- Add `"start:worker": "nest start --entryFile worker-main"` (and a `start:worker:dev --watch` variant) to `package.json`; declare the extra entry in `nest-cli.json` if needed (single tsconfig build emits both entrypoints)
- Create `nestjs-project/Dockerfile.worker` — same Node base as `Dockerfile.dev` + `apt install -y ffmpeg`; CMD `tail -f /dev/null` (dev convention — command run via compose)
- Add `video-worker` service to `compose.yaml` — build `Dockerfile.worker`, same volume mount, `command: npm run start:worker:dev`, depends_on db/redis/minio healthy
- Worker containers resolve MinIO through the internal endpoint; presigned URLs used by ffmpeg are signed with the internal endpoint (worker-side presign uses the SDK client, not the public one)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/ffmpeg.service.spec.ts` | Unit | Arg construction, stderr error propagation, timeout handling (spawn mocked) |
| `src/worker/video.processor.spec.ts` | Unit | Branches: missing video row (no-op), thumbnail timing rule (1s vs 10%), final-failure handler sets failed + error_message (repos/services mocked) |
| `src/worker/video.processor.integration-spec.ts` | Integration | Real DB + MinIO + Redis + real ffmpeg (runs inside the worker container): upload a tiny real MP4 fixture, run the processor on a real job → row becomes `ready` with duration/metadata, thumbnail object exists in storage; corrupt-file job path ends `failed` with error_message |
| `src/worker/worker.module.spec.ts` | Unit | Module compiles |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `docker compose up -d` brings up the `video-worker` container consuming the queue
- Completing an upload of a real (small) video results, without any further API call, in status `ready`, `duration_seconds`/`metadata` populated and a JPEG thumbnail stored in MinIO
- A corrupt/unreadable source exhausts 3 attempts and lands the video in `failed` with `error_message` persisted
- Worker integration tests run inside the worker container (`docker compose exec video-worker npm test -- --runInBand <file>`) because they need the ffmpeg binary

---

### SI-03.8 — Video Read, Streaming, and Download Endpoints

**Description:** Implement the read-side endpoints (TD-08): video details by `url_id` (including a presigned thumbnail URL when ready), a stream URL endpoint and a download URL endpoint — both issuing short-lived presigned GETs served directly by storage, honoring the authorization semantics fixed in TD-08's revision.

**Technical actions:**

- Implement in `VideosService`:
  - `findByUrlId(urlId: string): Promise<Video>` — with channel relation; `VideoNotFoundException` on miss
  - `getStreamUrl(urlId: string): Promise<{ url: string; expiresInSeconds: number }>` — status ≠ `ready` → `VideoNotReadyException`; presign GET on `storage_key`
  - `getDownloadUrl(urlId: string)` — same guard; presign with `ResponseContentDisposition: attachment; filename="{original filename}"`
- Add `VideoNotReadyException` (409 `VIDEO_NOT_READY`) to the domain exceptions
- Create `src/videos/dto/video-response.dto.ts` — response shape: `id`, `urlId`, `title`, `status`, `durationSeconds`, `metadata`, `thumbnailUrl` (presigned, null until ready), `createdAt`, `channel: { id, name, nickname }`
- Add to `VideosController`: `@Get(':urlId')` (200), `@Get(':urlId/stream-url')` (200), `@Get(':urlId/download-url')` (200) — all authenticated (anonymous playback is Phase 05; TD-08 revision)
- Re-export `openapi.json` (`npm run openapi:export` or the project's export script) so the committed spec includes the new endpoints (openapi-docs-nestjs/TD-02)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Not-ready guard for stream/download; thumbnail URL only when ready |
| `src/videos/videos.service.integration-spec.ts` | Integration | Presigned stream URL of a processed video serves bytes from MinIO with 206 on Range; download URL carries the attachment disposition |
| `test/videos.e2e-spec.ts` | E2E | Full lifecycle: initiate → upload → complete → (worker processes) → GET details shows `ready` + metadata; stream-url plays (Range 206 via fetch follow-up); download-url has attachment header; 409 VIDEO_NOT_READY while draft/processing; 404 unknown urlId; any authenticated user (not only owner) can stream a ready video |

**Dependencies:** SI-03.3, SI-03.2 (unit/integration); full-lifecycle E2E additionally exercises SI-03.5–03.7

**Acceptance criteria:**

- `GET /videos/{urlId}/stream-url` for a `ready` video returns a URL that MinIO serves with `206 Partial Content` under a `Range` request — playback needs no full download
- `GET /videos/{urlId}/download-url` returns a URL whose response carries `Content-Disposition: attachment`
- Both return 409 `VIDEO_NOT_READY` for non-ready videos and are accessible to any authenticated user for ready ones
- `openapi.json` committed in sync with the new endpoints

---

### SI-03.9 — Abandoned Upload Cleanup

**Description:** Implement the abandoned-draft reclaim path fixed in TD-06's revision: drafts whose upload never completed become cleanup-eligible after 24h — the multipart upload is aborted in storage and the row deleted. Exposed as a service-level maintenance operation (scheduled sweep deliberately deferred).

**Technical actions:**

- Implement `cleanupAbandonedUploads(now?: Date): Promise<number>` in `VideosService` — select videos where `status = 'draft'`, `upload_id IS NOT NULL`, `created_at < now - ABANDONED_UPLOAD_TTL_HOURS`; for each: `storage.abortMultipartUpload` (tolerating already-aborted/NoSuchUpload) then delete the row; return the count
- Document in the service docblock that scheduling (cron) is deferred until an operational need appears (TD-06 revision)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Selection boundary (24h TTL), tolerance to storage abort errors |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real MinIO + DB: stale draft with a real pending multipart upload is aborted in storage and removed from the DB; fresh drafts and non-drafts untouched |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- A 25h-old draft with a pending multipart upload is fully reclaimed (no row, no pending upload in MinIO)
- Fresh drafts, processing/ready/failed videos are never touched by the cleanup

---

### SI-03.10 — Phase Closure: Full Suite, OpenAPI Sync, and Documentation

**Description:** Close the phase per the Definition of Done: full test suite green (unit + integration + e2e), `tsc --noEmit` exit 0, lint clean, `openapi.json` in sync, and both `CLAUDE.md` files updated with the videos module, queue/worker and storage documentation coherent with the real code.

**Technical actions:**

- Run the DoD battery in-container: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint`, `npm run build`
- Verify `openapi.json` is current (re-export and diff — commit if drifted)
- Update `nestjs-project/CLAUDE.md` — services table (minio, redis, video-worker), worker commands (`start:worker`, worker-container test execution), storage/queue env vars, and any new test-execution notes discovered during the phase
- Update root `CLAUDE.md` — architecture section: Message Queue is no longer "TBD" (BullMQ + Redis); videos module summary and endpoints; worker container
- Update `docs/diagrams/software-arch.mermaid` — replace `ContainerQueue(queue, "Message Queue", "TBD", ...)` with BullMQ/Redis
- Update `progress.md` with the final status of every SI

**Dependencies:** SI-03.1 through SI-03.9

**Acceptance criteria:**

- Definition of Done passes end-to-end in the containers (full suite + tsc + lint + build)
- `CLAUDE.md` (root and nestjs-project) mention only files, services and behaviors that exist in the code
- Architecture diagram reflects the decided queue stack

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| channel_id | uuid | FK → channels.id, not null | Owning channel (per project-plan: videos belong to a channel) |
| title | varchar(255) | not null | Defaults to filename without extension at initiation |
| url_id | varchar(21) | unique, not null | nanoid(11) public identifier (TD-05) |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | Lifecycle per TD-06 |
| storage_key | varchar | not null | `videos/{id}/original{ext}` (TD-07) |
| thumbnail_key | varchar | nullable | `thumbnails/{id}.jpg`, set by worker |
| upload_id | varchar | nullable | S3 multipart UploadId; cleared on completion |
| content_type | varchar(100) | not null | Declared at initiation, `video/*` |
| original_filename | varchar(255) | not null | Used for download Content-Disposition |
| size_bytes | bigint | not null | Declared at initiation; verified at completion (≤ 10 GiB) |
| duration_seconds | int | nullable | Set by worker (ffprobe) |
| metadata | jsonb | nullable | `{ width, height, codec, format, sizeBytes }` per TD-04 revision |
| error_message | text | nullable | Set by worker on final processing failure |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one via `channel_id`)
**Indexes:** `(url_id)` — unique; `(channel_id)` — FK lookups; `(status, created_at)` — cleanup/listing queries

---

### API Contracts

All endpoints require a valid access token (global JWT guard; no `@Public()` in this phase — anonymous playback is Phase 05).

#### POST /videos/uploads (SI-03.5)

**Request body:**
- filename: string, required — max 255
- contentType: string, required — must match `video/*`
- sizeBytes: integer, required — > 0 and ≤ 10 GiB (10737418240)
- title: string, optional — max 255; defaults to filename without extension

**Response 201:**
- video: { id: uuid, urlId: string(11), title: string, status: "draft" }
- upload: { partSizeBytes: 104857600, partCount: number, parts: [{ partNumber: number, url: string }] }

**Error responses:**
- 400 VALIDATION_ERROR: invalid body (including sizeBytes above the 10 GiB gate)
- 401: missing/invalid token

#### POST /videos/:videoId/upload/part-urls (SI-03.5)

**Request body:**
- partNumbers: integer[], required — each within 1..partCount

**Response 200:**
- parts: [{ partNumber, url }]

**Error responses:**
- 404 VIDEO_NOT_FOUND · 403 NOT_VIDEO_OWNER · 409 UPLOAD_NOT_IN_PROGRESS · 400 VALIDATION_ERROR

#### POST /videos/:videoId/upload/complete (SI-03.6)

**Request body:**
- parts: [{ partNumber: integer, etag: string }], required, non-empty

**Response 200:**
- id: uuid · urlId: string · status: "processing"

**Error responses:**
- 404 VIDEO_NOT_FOUND · 403 NOT_VIDEO_OWNER · 409 UPLOAD_NOT_IN_PROGRESS · 400 UPLOAD_INCOMPLETE (stored size ≠ declared size or storage completion failure)

#### GET /videos/:urlId (SI-03.8)

**Response 200:**
- id, urlId, title, status, durationSeconds (null until ready), metadata (null until ready), thumbnailUrl (presigned, null until ready), createdAt, channel: { id, name, nickname }

**Error responses:**
- 404 VIDEO_NOT_FOUND

#### GET /videos/:urlId/stream-url (SI-03.8)

**Response 200:**
- url: string (presigned GET, TTL 3600s — storage serves Range/206 natively)
- expiresInSeconds: 3600

**Error responses:**
- 404 VIDEO_NOT_FOUND · 409 VIDEO_NOT_READY

#### GET /videos/:urlId/download-url (SI-03.8)

**Response 200:**
- url: string (presigned GET with `ResponseContentDisposition: attachment; filename="{original_filename}"`)
- expiresInSeconds: 3600

**Error responses:**
- 404 VIDEO_NOT_FOUND · 409 VIDEO_NOT_READY

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner-only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos/uploads | | ✓ | | Video is created under the caller's own channel |
| POST /videos/:videoId/upload/part-urls | | ✓ | ✓ | 403 NOT_VIDEO_OWNER otherwise |
| POST /videos/:videoId/upload/complete | | ✓ | ✓ | 403 NOT_VIDEO_OWNER otherwise |
| GET /videos/:urlId | | ✓ | | Any authenticated user |
| GET /videos/:urlId/stream-url | | ✓ | | Any authenticated user, `ready` only (TD-08 revision) |
| GET /videos/:urlId/download-url | | ✓ | | Any authenticated user, `ready` only (TD-08 revision) |

Anonymous access to playback is explicitly deferred to Phase 05.

---

### Error Catalog

Error response format inherited from Phase 02: `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `:videoId`/`:urlId` route with unknown id |
| NOT_VIDEO_OWNER | 403 | You do not own this video | Upload part-urls/complete by a user whose channel doesn't own the video |
| UPLOAD_NOT_IN_PROGRESS | 409 | No upload in progress for this video | part-urls/complete when status ≠ draft or upload_id is null (includes double-complete) |
| UPLOAD_INCOMPLETE | 400 | Upload incomplete or size mismatch | complete when stored object size ≠ declared sizeBytes or storage completion fails |
| VIDEO_NOT_READY | 409 | Video is not ready yet | stream-url/download-url while status ∈ {draft, processing, failed} |
| FILE_TOO_LARGE | 413 | File exceeds the 10GB limit | Defensive service-level gate (DTO validation normally answers 400 first) |
| UNSUPPORTED_MEDIA_TYPE | 415 | Content type must be video/* | Defensive service-level gate (DTO validation normally answers 400 first) |
| VALIDATION_ERROR | 400 | (field errors array) | Inherited from Phase 02 global ValidationPipe |

---

### Events/Messages

#### video-processing / process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoQueueProducer` (API — called by `VideosService.completeUpload`, per phase-03-videos/TD-01 and TD-03)
**Consumer:** `VideoProcessor` (video-worker container, per phase-03-videos/TD-04)
**Trigger:** upload completion confirmed (multipart completed + object verified) — status already `processing` in DB
**Delivery semantics:** at-least-once (BullMQ/Redis, per phase-03-videos/TD-01). Processor is idempotent: re-processing a `ready` video rewrites the same metadata/thumbnail keys.
**Retry policy:** `attempts: 3`, exponential backoff (5s base). On final failure the worker sets `status = failed` + `error_message` (per phase-03-videos/TD-06); DB row is the source of truth, the queue is transport only.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2 (storage)
├── SI-03.3 (entity + migration)
└── SI-03.4 (queue + producer)

SI-03.2 + SI-03.3
└── SI-03.5 (upload initiation)
    └── SI-03.9 (abandoned cleanup)

SI-03.4 + SI-03.5
└── SI-03.6 (completion + enqueue)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.7 (worker + ffmpeg + container)

SI-03.2 + SI-03.3 (+ SI-03.5..7 for the full-lifecycle E2E)
└── SI-03.8 (read / stream / download)

SI-03.1 .. SI-03.9
└── SI-03.10 (closure: DoD + docs)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10

---

## Deliverables

- [ ] MinIO (S3-compatible object storage), Redis and the video-worker containers running via `docker compose up -d` alongside the existing stack
- [ ] `videos` table created by migration, entity linked to `channels`, status enum draft/processing/ready/failed
- [ ] Upload initiation with automatic draft pre-registration and presigned multipart part URLs (100 MiB parts, 10 GiB ceiling enforced at initiation — zero video bytes through the API)
- [ ] Part-URL re-issue endpoint (resume after connection failure / URL expiry)
- [ ] Explicit upload completion: multipart completed, object verified, status → processing, job enqueued
- [ ] BullMQ `video-processing` queue with 3-attempt exponential backoff retry policy
- [ ] Video worker container (FFmpeg installed) consuming jobs: ffprobe metadata (duration, width, height, codec, format, size) + JPEG thumbnail from a video frame, straight from storage via URL
- [ ] Status lifecycle reflected in the DB, including `failed` + `error_message` on processing failure
- [ ] Unique 11-char `url_id` per video (nanoid v3, unique index — no conflicts by construction)
- [ ] Streaming via presigned GET served by storage with native Range/206 (no full download needed) and download with attachment disposition
- [ ] Abandoned-upload cleanup (24h TTL: abort multipart + delete draft)
- [ ] `openapi.json` re-exported in sync with the new endpoints
- [ ] Tests at all levels against real Compose infra (MinIO, Redis, ffmpeg) — no mocking of what the infra can exercise
- [ ] `progress.md` updated per SI
- [ ] Definition of Done: full suite green (`npm test -- --runInBand`, `npm run test:e2e`), `npx tsc --noEmit` exit 0, `npm run lint` clean, `npm run build` succeeds — all in-container
- [ ] `CLAUDE.md` (root + nestjs-project) and `docs/diagrams/software-arch.mermaid` updated coherently with the delivered code
