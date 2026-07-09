---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-09
scope_description: "Backend foundation for video upload and processing: object storage usage (S3/MinIO), processing queue technology, 10GB upload strategy, video worker topology (FFmpeg), unique URL generation, streaming/download delivery, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload orchestration, queue producer, streaming/download endpoints), the video worker (queue consumer + FFmpeg), and the new Compose infrastructure (object storage, queue broker, worker container).
- `next-frontend/` — Frontend deferred: the video upload/watch UI is explicitly out of scope for this phase (per the challenge statement). Cross-layer TDs (upload protocol, streaming delivery) define the contract the frontend will consume in a future phase. No frontend-only TD in this document.

---

## TD-01: Video Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram lists the Message Queue as "TBD" — this is the main open stack decision of the phase. The API must publish video-processing jobs after upload completion; a separate worker consumes them, runs FFmpeg, and updates DB/storage. Requirements: at-least-once delivery, automatic retries with backoff, failure visibility (dead-letter behavior feeding the video `failed` status), and everything running locally via Docker Compose.

**Options:**

### Option A: BullMQ + Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue for Node.js. The API registers a producer (`Queue`) and the worker registers a processor (`Worker`/`@Processor`) over the same Redis instance. NestJS ships an official integration (`@nestjs/bullmq`) with DI modules for producers and consumers.
- **Pros:** De facto standard for Node.js background jobs (media pipelines are its canonical use case). Official NestJS module — producers and consumers are injectable, testable NestJS providers. Built-in retries with exponential backoff, per-job attempts, `failed` events, delayed jobs, concurrency control. Redis is a single lightweight container in Compose. Job state is inspectable (useful for tests and debugging).
- **Cons:** Adds Redis as new infrastructure (one more service to operate). At-least-once semantics tied to Redis persistence configuration. Queue state lives outside PostgreSQL — two sources of truth to reconcile (mitigated: video status in DB is the source of truth; the queue is transport).

### Option B: RabbitMQ (`@golevelup/nestjs-rabbitmq` or `@nestjs/microservices` AMQP transport)
- Dedicated AMQP broker. The API publishes messages to an exchange; the worker consumes from a queue with acks, prefetch and dead-letter exchanges.
- **Pros:** Purpose-built broker with the richest delivery semantics (acks, DLX, prefetch, routing). Language-agnostic — if the worker were ever rewritten (e.g., Python/FFmpeg), the contract survives. Mature management UI.
- **Cons:** Heaviest option to operate and configure (exchanges, bindings, DLX policies). `@nestjs/microservices` AMQP support is RPC-oriented and awkward for long-running jobs; the community package (`@golevelup`) is solid but third-party. Retry/backoff must be assembled from DLX + TTL patterns — more moving parts than BullMQ's built-in retries. Overkill for a single producer/consumer pair.

### Option C: pg-boss (PostgreSQL-based queue)
- Job queue implemented over PostgreSQL (`SKIP LOCKED`). The API `send()`s jobs; the worker `work()`s them. Retries, backoff and dead-letter queues built in.
- **Pros:** Zero new infrastructure — reuses the PostgreSQL 17 already in the stack. Transactional enqueue possible (job insert can share a transaction with the video status update). Built-in retries/DLQ.
- **Cons:** Queue throughput bounded by the DB and polling (LISTEN/NOTIFY mitigates). Couples job workload to the transactional database — heavy processing load competes with API queries. No official NestJS module — manual wiring of lifecycle and DI. Weaker fit with the architecture diagram, which models the queue as a **separate container** ("Message Queue" box); pg-boss makes it a table inside the DB.

**Recommendation:** **Option A (BullMQ + Redis)** — Best fit for a Node-only producer/consumer pair with heavy media jobs: official NestJS integration, first-class retries/backoff/failure events (which map directly onto the video status lifecycle in TD-06), and one small Redis container in Compose. RabbitMQ's extra semantics aren't needed for a single job type, and pg-boss contradicts the target architecture's dedicated queue container while coupling video processing load to the transactional DB.

**Decision:** A (BullMQ + Redis)

**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: 10GB Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Uploads of up to 10GB must not hold API resources (routing the file through Node/Express would pin sockets, event loop and disk for hours) and, per project-plan "Pontos de Atenção", must be resumable after connection failures. The object storage is fixed (S3-compatible MinIO — see TD-07 for bucket/key layout); what is open is **how bytes reach it**. Cross-layer: the handshake sequence is implemented by the API and executed by the client.

**Options:**

### Option A: Presigned multipart upload direct to storage
- Client asks the API to start an upload → API pre-registers the video as draft (capability "Pré-cadastro automático"), calls `CreateMultipartUpload`, and issues presigned URLs for each part (`UploadPartCommand` + `@aws-sdk/s3-request-presigner`). The client PUTs parts (e.g., 100MB each) straight to MinIO/S3, collects ETags, and calls the API to complete → API runs `CompleteMultipartUpload` and enqueues processing.
- **Pros:** Zero video bytes through the API — only small JSON control calls. Resumable: failed parts are retried individually; pending uploads can re-request URLs for missing parts. Parts upload in parallel (better throughput). Native S3/MinIO API — no extra server. Scales to S3 in production unchanged.
- **Cons:** Client-side orchestration (part splitting, ETag collection, complete call). API must track `uploadId`/keys and garbage-collect abandoned uploads. Presigned URL expiration must be handled (re-issue).

### Option B: tus protocol (resumable upload server, e.g. `@tus/server`)
- Standardized resumable-upload protocol. The API (or a sidecar) exposes tus endpoints; the client uses a tus client library. Server can use an S3 storage backend (`@tus/s3-store`).
- **Pros:** Open protocol with mature clients (Uppy). Resumability is the protocol's core feature — offset-based, robust on flaky networks. `@tus/s3-store` writes to S3-compatible storage.
- **Cons:** Bytes flow through the tus server — either the NestJS process (back to the "API holds the upload" problem) or a new dedicated container (tusd) to operate. Extra protocol/dependency surface for a capability S3 multipart already covers. Storage-backend S3 store still relays every byte.

### Option C: Single presigned PUT (no multipart)
- API issues one presigned `PutObjectCommand` URL; client PUTs the whole file in a single request.
- **Pros:** Simplest possible flow — one URL, one request. Zero bytes through the API.
- **Cons:** A 10GB single PUT cannot be resumed — any connection failure restarts from byte zero (violates the resumability attention point). No parallelism. S3 PUT hard limit is 5GB — **does not meet the 10GB requirement at all**.

**Recommendation:** **Option A (presigned multipart upload)** — the only option that simultaneously keeps video bytes out of the API, is resumable per part, parallelizes, and needs no new infrastructure beyond the already-decided S3-compatible storage. Option C is disqualified by S3's 5GB single-PUT limit; tus adds a byte-relaying server for a problem multipart already solves.

**Decision:** A (Presigned multipart upload direct to storage)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-07-09 — Operational parameters fixed (resolves validation AMB-3): part size 100 MiB
  (S3 minimum is 5 MiB; 10 GiB ≈ 103 parts, far below the 10,000-part S3 limit); presigned
  part-upload URL TTL 1 hour (client re-requests URLs for remaining parts on expiry); the
  10 GiB ceiling is enforced at upload initiation — the client declares the total file size,
  the API rejects > 10 GiB with a domain error before any storage call. Rationale: these are
  cross-component values (DTO validation + client contract + storage config) that the plan's
  Technical Specs reference as constants.

---

## TD-03: Upload Completion Signal

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** With uploads going directly to storage (TD-02), the API must learn that the file landed so it can flip the video status and enqueue processing. Two integration styles exist: the client tells the API, or the storage tells the API.

**Options:**

### Option A: Explicit client completion call
- The client, after uploading all parts, calls `POST /videos/:id/complete` with the part ETags. The API executes `CompleteMultipartUpload`, verifies the object (`HeadObject`), updates status and enqueues the processing job — all in one place.
- **Pros:** Single, explicit, synchronous transition — trivially testable (integration/e2e can drive the whole lifecycle). No storage-side configuration. The complete call is already required by the multipart flow (someone must send the ETag list); enqueueing there adds no extra hop.
- **Cons:** Trusts the client to call complete — abandoned uploads need a cleanup policy (draft + no complete). If the client dies after uploading parts but before completing, parts sit until aborted.

### Option B: MinIO bucket event notifications
- Configure MinIO to publish `s3:ObjectCreated:*` events (webhook to the API or directly into Redis). The API/worker reacts to the storage event, updates status, enqueues processing.
- **Pros:** Storage is the source of truth — no client trust needed. Works even if the client vanishes right after the last byte.
- **Cons:** MinIO-specific wiring (`mc event add` / notification targets) that differs from AWS (EventBridge/SQS) — breaks the "swap MinIO for S3" portability goal. Harder to test deterministically. The multipart complete call still must come from somewhere, so B adds a second signal path rather than replacing the first.

**Recommendation:** **Option A (explicit completion call)** — the complete call is intrinsic to multipart upload anyway; making it the single status/enqueue trigger keeps the flow explicit, portable across MinIO/S3, and directly exercisable by the test suite. Abandoned-upload cleanup is handled as a lifecycle policy (TD-06).

**Decision:** A (Explicit client completion call)

---

## TD-04: Video Worker Topology and FFmpeg Execution

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture diagram defines a dedicated "Video Worker (FFmpeg)" container consuming jobs from the queue. Open questions: how the worker process is built and deployed (relative to the NestJS codebase), and how it invokes FFmpeg/ffprobe for metadata extraction and thumbnail generation.

**Options:**

### Option A: Same codebase, separate entrypoint + container (NestJS standalone application context)
- The worker lives in `nestjs-project/src/` as a module with BullMQ processors, booted by a second entrypoint (e.g., `worker-main.ts` via `NestFactory.createApplicationContext`). Compose runs a second container from the same image with a different command; FFmpeg/ffprobe installed in the image (or a worker-specific Dockerfile).
- **Pros:** Reuses TypeORM entities, config namespaces, storage service and queue definitions — zero duplication. One `package.json`, one test suite, one lint/tsc gate (fits the existing Definition of Done). Separate container = separate lifecycle/resources, matching the architecture diagram. NestJS DI available in the worker (repositories, config).
- **Cons:** API and worker share dependencies — worker deploys carry API code (acceptable at this scale). Worker crash-isolation only at container level, not repo level.

### Option B: Separate project/package for the worker
- New `video-worker/` directory with its own `package.json`, connecting to the same Redis and DB.
- **Pros:** Hard isolation; worker dependencies (FFmpeg wrappers) never touch the API's tree. Independent scaling/deploy artifacts.
- **Cons:** Duplicates entities, config, storage client and DB access (or forces a shared-package refactor of the monorepo — out of scope). Second test/lint/build pipeline. Contradicts "Continuidade, não retrabalho" — the repo's conventions (single nestjs-project backend) offer no precedent.

**FFmpeg invocation (sub-decision, applies to either option):**

### Sub-option F1: Spawn `ffprobe`/`ffmpeg` binaries directly (`child_process`)
- `ffprobe -print_format json` for duration/metadata; `ffmpeg -ss <t> -i <url> -frames:v 1` for the thumbnail. Binaries installed via `apt` in the worker image.
- **Pros:** No wrapper dependency (the popular `fluent-ffmpeg` was deprecated/unmaintained in 2024 and its API adds little for two fixed commands). Full control of args; presigned/HTTP(S) input URLs supported natively by FFmpeg — the worker can read straight from storage without downloading 10GB to disk.
- **Cons:** Manual arg building and stderr parsing; must handle process errors/timeouts explicitly.

### Sub-option F2: Wrapper library (`fluent-ffmpeg`)
- Fluent JS API over ffmpeg/ffprobe.
- **Pros:** Ergonomic API, progress events.
- **Cons:** Effectively unmaintained (repository archived in 2024, later restored in maintenance mode); an unmaintained dependency for two fixed command lines is unjustified risk.

**Recommendation:** **Option A + F1** — same codebase with a dedicated worker entrypoint and container (maximum reuse, single quality gate, matches the C4 diagram), spawning `ffprobe`/`ffmpeg` directly with FFmpeg installed in the worker image. FFmpeg reads the source via URL from storage, avoiding a 10GB local download for metadata/thumbnail extraction.

**Decision:** A + F1 (same codebase, worker entrypoint + separate container; direct ffprobe/ffmpeg spawn)

**Revisions:**
- 2026-07-09 — Persisted metadata set fixed (resolves validation AMB-1): duration in seconds
  (dedicated column, rounded to integer), plus width, height, video codec name, container
  format name and file size in bytes (persisted as a structured `metadata` JSONB payload
  extracted from ffprobe's stream/format output). Thumbnail: single JPEG frame captured at
  second 1 (or 10% of duration for videos shorter than 10s), stored under the thumbnails/
  key prefix. Rationale: the capability names only "duração e metadados"; the Data Model
  needs an exact field list.

---

## TD-05: Unique Video URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, never-conflicting public URL identifier (project-plan attention point: "URL curta e única"). The videos table already has a UUID primary key; the question is what the public URL identifier is.

**Options:**

### Option A: `nanoid` public ID in a dedicated unique column
- Generate an 11-char URL-safe ID (e.g., `V1StGXR8_Z5`) with `nanoid` at video pre-registration; store in `videos.url_id` with a unique index. Collision probability is negligible (~64^11); the unique constraint + one retry covers the theoretical case.
- **Pros:** Short, URL-safe, YouTube-like. Decoupled from the DB PK (safe to expose; no enumeration). Trivial to generate/test; unique index makes conflicts impossible by construction.
- **Cons:** One extra column/index; theoretical collision needs a retry path (one `catch` on unique violation).

### Option B: Reuse the UUID primary key in the URL
- The video's `id` (uuid v4) is the public URL.
- **Pros:** Zero extra code or columns; uniqueness guaranteed.
- **Cons:** 36-char URLs — fails the "URL curta" attention point. Exposes the PK directly.

### Option C: Title-derived slug + random suffix
- Slugify the title (`my-video-x7f3`) with a random suffix for uniqueness.
- **Pros:** Human-readable, SEO-friendly URLs.
- **Cons:** Title changes (Phase 04 edits titles) either break URLs or desynchronize slug↔title. Sanitization/transliteration edge cases (same class of problems as TD-10/phase-02 nicknames). More logic for little gain in a player URL.

**Recommendation:** **Option A (`nanoid` in `videos.url_id`)** — meets "curta e única" directly, avoids PK exposure, and the unique index gives a hard non-conflict guarantee; slugs are hostile to Phase-04 title edits.

**Decision:** A (nanoid public ID in unique column)

**Libraries:** nanoid@3

**Revisions:**
- 2026-07-09 — Pinned to nanoid v3.x: v4+ is ESM-only and cannot be require()d by the
  project's CommonJS runtime (ts-node/ts-jest + nodenext CJS output). v3 keeps the same
  API surface (nanoid(size)) and remains security-maintained. Rationale: installed-stack
  compatibility per the research skill's version-check rule.

---

## TD-06: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video must be pre-registered as a draft when upload starts and progress through processing to a playable state, with failures visible. The exact state machine, who owns each transition, and what happens when FFmpeg fails (retries? terminal state?) must be fixed before planning.

**Options:**

### Option A: Four states — `draft → processing → ready | failed`; retries inside the queue; `failed` is terminal-but-retryable
- `draft`: created at upload start (covers the entire upload window). `processing`: set by the API at completion call, when the job is enqueued. `ready`: set by the worker after metadata+thumbnail persist. `failed`: set by the worker when the job exhausts BullMQ retries (3 attempts, exponential backoff); the error is stored (`error_message`), and a future re-enqueue (manual or Phase 04+) may return it to `processing`.
- **Pros:** Minimal states, each owned by exactly one actor (API: draft/processing; worker: ready/failed) — no racing writers per state. Retries stay in the queue layer (BullMQ `attempts`/`backoff`) instead of polluting the domain model. Status in DB is the single source of truth for the frontend.
- **Cons:** No distinct `uploading` vs `uploaded` observability (the draft state spans both). Stalled *processing* jobs (worker crash mid-run) rely on BullMQ's stalled-job detection to re-deliver.

### Option B: Six states — `draft → uploading → uploaded → processing → ready | failed`
- Adds explicit `uploading` (parts in flight) and `uploaded` (complete called, not yet picked by worker).
- **Pros:** Finer-grained observability; abandoned uploads distinguishable from never-started drafts.
- **Cons:** More transitions to guard and test; `uploading`/`uploaded` are distinctions the client mostly can't see anyway (parts go straight to storage, and queue pickup is sub-second locally). Phase-04's draft/publish flow will re-use `draft` — extra states now are speculative.

**Failure policy (both options):** BullMQ job config `attempts: 3`, exponential backoff; on final failure the worker sets `failed` + `error_message`. Drafts older than a TTL with no completed upload are eligible for cleanup (abort multipart + delete row) — implemented as a maintenance concern, not a user flow.

**Recommendation:** **Option A (four states)** — smallest machine that satisfies the capabilities; every state has a single writer; queue-level retries keep transient FFmpeg/storage errors out of the domain. Option B's extra states add test surface without a consumer in this phase.

**Decision:** A (draft → processing → ready | failed; BullMQ retries; error persisted on failure)

**Revisions:**
- 2026-07-09 — Abandoned-upload policy fixed (resolves validation AMB-3, cleanup TTL):
  drafts whose upload was never completed become eligible for cleanup 24 hours after
  creation — cleanup aborts the multipart upload in storage and deletes the draft row.
  Exposed as a service-level maintenance operation exercised by integration tests; a
  scheduled sweep (cron) is deliberately deferred until an operational need appears.
  Rationale: TD-03's trust-the-client completion model needs a documented reclaim path.

---

## TD-07: Object Storage Usage — Buckets, Keys, and Access Modes

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage itself is fixed (S3-compatible; MinIO in Compose, S3 in production). What must be decided is the bucket/key organization, access policy, and how the API/worker authenticate — the contract every storage read/write in the phase follows.

**Options:**

### Option A: Single private bucket, prefix-per-type keys, all access via presigned URLs / SDK credentials
- One bucket (`streamtube-videos`), keys `videos/{videoId}/original.{ext}` and `thumbnails/{videoId}.jpg`. Bucket stays private; clients interact only through presigned URLs (upload per TD-02, playback/download per TD-08); API and worker use SDK credentials (env-configured), `forcePathStyle: true` for MinIO.
- **Pros:** One bucket to provision/configure in Compose (idempotent bootstrap). Prefixes keep videos/thumbnails organized while sharing lifecycle policy. Private-by-default — access always mediated by the API issuing presigned URLs (authorization stays in one place). Path-style + env-driven endpoint makes MinIO↔S3 swap a config change.
- **Cons:** Presigned URLs required even for public-ish thumbnails (slight overhead per listing — acceptable now; a CDN/public policy can be added later without re-keying).

### Option B: Two buckets (private videos, public thumbnails)
- `videos` bucket private; `thumbnails` bucket with public-read policy for direct `<img>` URLs.
- **Pros:** Thumbnails served without presigning — simpler for future listing pages.
- **Cons:** Public bucket policy is extra Compose/MinIO bootstrap complexity now, for a frontend that doesn't exist in this phase. Two buckets to keep consistent. Public-read on MinIO ≠ same mechanics on S3+CDN (portability caveat).

**Recommendation:** **Option A (single private bucket, prefixed keys, presigned access)** — smallest consistent surface; authorization centralized in the API; trivially portable to S3. Splitting/publicizing thumbnails is a Phase-05+ optimization that doesn't pay for itself before the video UI exists.

**Decision:** A (single private bucket, prefix-per-type keys, presigned-only access)

**Libraries:** @aws-sdk/client-s3

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTML5 video seeking depends on HTTP Range / `206 Partial Content`), and users must be able to download videos. The delivery path determines who serves the heavy bytes: the storage or the API. Cross-layer: the frontend player consumes whatever contract is chosen; the architecture diagram already draws "Frontend → streams from → Object Storage".

**Options:**

### Option A: Presigned GET URLs — player and download hit storage directly
- API exposes e.g. `GET /videos/{urlId}/stream-url` (and `/download-url`) returning a short-lived presigned `GetObjectCommand` URL (download variant sets `ResponseContentDisposition: attachment`). The browser/player requests MinIO/S3 directly; S3/MinIO natively serve Range requests with `206`, so streaming and seeking work out of the box.
- **Pros:** Matches the C4 diagram exactly (frontend streams from Object Storage). API never proxies video bytes — same principle that justified TD-02. Range/206 handled natively by storage — zero streaming code to write or maintain. Download is one parameter. Expiring URLs keep the bucket private (TD-07) while allowing anonymous playback later (Phase 05) — the API decides who gets a URL.
- **Cons:** Two-step fetch for the player (get URL, then stream). URL expiry must exceed plausible watch time or the player must re-request. e2e tests assert the URL contract + follow it to storage rather than asserting bytes from the API itself.

### Option B: API streaming proxy with Range support
- `GET /videos/{urlId}/stream` on the API reads `Range` headers, issues ranged `GetObject` to storage, pipes the body with `206`/`Content-Range` headers.
- **Pros:** Single-origin API contract (no second hop); fine-grained per-request authorization; bytes never expose the storage endpoint.
- **Cons:** Every watched second flows through Node — the exact resource-pinning the phase forbids for upload, now on the (much hotter) read path. Range/206 logic hand-written and easy to get subtly wrong. Contradicts the architecture diagram. Doesn't scale without adding the CDN that Option A gets for free from S3.

**Recommendation:** **Option A (presigned GET, direct-from-storage)** — consistent with TD-02/TD-07 and the target architecture: the API authorizes and signs; the storage serves bytes and speaks Range/206 natively. Proxying gigabytes through Node re-creates the problem the phase exists to avoid.

**Decision:** A (presigned GET URLs; download via `ResponseContentDisposition: attachment`)

**Libraries:** @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-07-09 — Authorization semantics for this phase fixed (resolves validation AMB-2):
  stream and download URLs are issued to any *authenticated* user for videos with status
  `ready`; requests for non-ready videos return a domain error (VIDEO_NOT_READY). Anonymous
  playback is explicitly Phase 05 scope (global JWT guard stays authoritative here).
  Presigned GET URL TTL: 1 hour. Rationale: the Authorization Matrix needs a per-endpoint
  rule and the capability bullets don't state one for this phase.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Video Processing Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Cross-layer | 10GB Upload Strategy | Presigned multipart direct to storage | A (Presigned multipart) |
| TD-03 | Backend | Upload Completion Signal | Explicit client completion call | A (Explicit completion call) |
| TD-04 | Backend | Worker Topology & FFmpeg Execution | Same codebase + worker container; direct ffprobe/ffmpeg spawn | A + F1 |
| TD-05 | Backend | Unique Video URL Strategy | nanoid public ID in unique column | A (nanoid `url_id`) |
| TD-06 | Backend | Status Lifecycle & Failure Policy | draft → processing → ready \| failed; queue-level retries | A (four states) |
| TD-07 | Backend | Object Storage Usage (buckets/keys/access) | Single private bucket, prefixed keys, presigned access | A (single private bucket) |
| TD-08 | Cross-layer | Streaming & Download Delivery | Presigned GET direct from storage | A (presigned GET) |
