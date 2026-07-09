# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/10 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Compose Infrastructure (MinIO + Redis)
- **Status:** completed
- **Tests:** 8/8 passing (env.validation.integration-spec.ts extended with storage/queue vars)
- **Observations:** First `docker compose up -d` pull of minio/minio failed with a TLS handshake timeout (network flake); retry succeeded. MinIO healthcheck uses `mc ready local` (bundled in the image).

### SI-03.2 — Storage Module (S3/MinIO Client Wrapper)
- **Status:** completed
- **Tests:** 8/8 passing (storage.service.integration-spec.ts: full multipart lifecycle, Range/206, attachment disposition, abort, headObject null; storage.module.spec.ts)
- **Observations:** Tests run inside the container, so the suite overrides `S3_PUBLIC_ENDPOINT` to the in-network MinIO hostname — presigned URLs signed with the host-facing endpoint are unreachable from within the Compose network. StorageService keeps two S3 clients (internal SDK ops vs public presigns).

### SI-03.3 — Video Entity, Migration, and Videos Module Scaffold
- **Status:** completed
- **Tests:** 7/7 passing (video.entity.integration-spec.ts: default status, url_id unique, FK to channels, jsonb round-trip, relation; videos.module.spec.ts; migrations.integration-spec.ts updated to 3 migrations/5 tables)
- **Observations:** `cleanAllTables` test helper now deletes `videos` first — the FK to channels would break cross-suite cleanup otherwise. Migration test also drops `videos_status_enum` (same orphan-enum pattern fixed in the baseline).

### SI-03.4 — Queue Module and Processing Producer
- **Status:** completed
- **Tests:** 2/2 passing (video-queue.producer.integration-spec.ts against real Redis: job payload + attempts/backoff; queue.module.spec.ts)
- **Observations:** QueueModule exports BullModule so consumers (worker) can register processors against the same queue registration.

### SI-03.5 — Upload Initiation with Draft Pre-registration
- **Status:** completed
- **Tests:** 9 unit (videos.service.spec.ts) + 2 integration (videos.service.integration-spec.ts, real MinIO PUTs via presigned URLs) + 8 e2e (videos.e2e-spec.ts)
- **Observations:** Video id generated app-side (crypto.randomUUID) so the storage key exists before the insert; failed draft insert aborts the just-created multipart upload to avoid orphan uploads. ChannelsService gained findByUserId (channel lookup is channels-domain logic); its constructor change required updating existing spec instantiations.

### SI-03.6 — Upload Completion and Processing Enqueue
- **Status:** completed
- **Tests:** 4 unit (guards, size mismatch, storage failure, single enqueue) + 2 integration (real part PUT → complete → object verified + job in Redis; mismatch keeps draft and reclaims object) + 3 e2e (200 processing, 409 double-complete, 403 non-owner)
- **Observations:** On size mismatch the assembled object is deleted and upload_id cleared — the multipart session is consumed by CompleteMultipartUpload, so the client must restart the upload (the row remains draft and is eligible for cleanup).

### SI-03.7 — Video Worker: FFmpeg Processing Pipeline and Worker Container
- **Status:** completed
- **Tests:** 13 unit (ffmpeg.service.spec, video.processor.spec: thumbnail timing, missing-row no-op, final-failure persistence) + 1 module + 2 integration in the worker container (real ffmpeg processes a real generated MP4 → ready with metadata + thumbnail in MinIO; corrupt source → failed with error_message)
- **Observations:** `autoLoadEntities` does not work in the worker (no forFeature for Channel/User) — entities registered explicitly since the Video relation graph reaches them. The worker integration suite self-skips (with instructions) in containers without ffmpeg; it must be run via `docker compose exec video-worker npm test -- --runInBand src/worker/video.processor.integration-spec.ts`. Fixture MP4 generated at test time with ffmpeg lavfi testsrc (no binary fixtures in the repo).

### SI-03.8 — Video Read, Streaming, and Download Endpoints
- **Status:** completed
- **Tests:** 7 unit (not-ready guards, thumbnail-only-when-ready, attachment filename) + 3 e2e including the full lifecycle: initiate → real presigned PUT → complete → REAL worker container processes with ffmpeg → details ready + thumbnail served → stream URL answers 206 to Range → download byte-identical with attachment disposition → any authenticated user can stream
- **Observations:** The lifecycle e2e requires the video-worker container running (docker compose up -d) — deliberate: the test exercises the real cross-container pipeline. Committed test/fixtures/sample-2s.mp4 (11KB, generated with ffmpeg lavfi testsrc). openapi.json re-exported with the 6 new /videos paths and synced to next-frontend.

### SI-03.9 — Abandoned Upload Cleanup
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.10 — Phase Closure: Full Suite, OpenAPI Sync, and Documentation
- **Status:** pending
- **Tests:** —
- **Observations:** —
