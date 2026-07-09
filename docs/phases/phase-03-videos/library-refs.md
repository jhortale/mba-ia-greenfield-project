---
libs:
  "bullmq":
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-09T16:26:00-0300"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-07-09T16:26:00-0300"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-09T16:26:00-0300"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-09T16:26:00-0300"
  "nanoid":
    version: "^3.3.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-09T16:26:00-0300"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-09T16:25:13-0300"
---

# phase-03-videos — Library References

Distilled, version-checked API notes for the libraries decided in this phase (fetched via Context7). Focus is limited to the surfaces the TDs actually use.

### bullmq

- **Used by:** TD-01 (queue), TD-06 (retries/failure policy).
- Producer: `new Queue(name, { connection })` / via Nest DI (see `@nestjs/bullmq`). Enqueue with `queue.add(jobName, data, opts)`.
- Job options for this phase: `attempts: 3`, `backoff: { type: 'exponential', delay: <ms> }` — after the final failed attempt the worker's `failed` handling runs (our processor sets video status `failed` + persists the error message).
- Consumer: `Worker(queueName, processor, { connection, concurrency })`. In Nest, prefer the `@Processor()` class (below) over a raw `Worker`.
- At-least-once semantics: processors must be idempotent (re-setting status `ready` + re-uploading a thumbnail with the same key is safe by design).
- Failure visibility: `worker.on('failed', (job, err) => ...)` fires per attempt; `job.attemptsMade` distinguishes intermediate retries from final failure (`job.attemptsMade >= job.opts.attempts`).
- Connection: pass Redis host/port via env (`redis` Compose service name, never localhost).

### @nestjs/bullmq

- **Used by:** TD-01, TD-04 (worker as Nest standalone context).
- Root registration: `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host, port } }) })` — matches the project's namespaced-config convention.
- Queue registration (producer side): `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; inject with `@InjectQueue(VIDEO_PROCESSING_QUEUE) private queue: Queue`.
- Consumer: `@Processor(VIDEO_PROCESSING_QUEUE) class VideoProcessor extends WorkerHost { async process(job: Job): Promise<void> { ... } }` — registered as a provider in the worker module; the standalone entrypoint (`NestFactory.createApplicationContext(WorkerModule)`) activates it.
- Worker-only options (concurrency) go in `registerQueue`'s `... { name, ... }` or the `@Processor(name, { concurrency })` decorator options.
- v11 targets NestJS 11 (peer). Package name for install: `@nestjs/bullmq` + `bullmq`.

### @aws-sdk/client-s3

- **Used by:** TD-02 (multipart), TD-03 (complete/verify), TD-07 (bucket/keys).
- Client for MinIO: `new S3Client({ endpoint, region, credentials, forcePathStyle: true })` — `forcePathStyle` is mandatory for MinIO (no virtual-host buckets); endpoint/credentials from env config namespace.
- Multipart flow: `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → returns `UploadId`; parts are uploaded by the client via presigned `UploadPartCommand` URLs; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })`; `AbortMultipartUploadCommand` for cleanup (TD-06 abandoned-draft policy).
- Verification: `HeadObjectCommand({ Bucket, Key })` returns `ContentLength` — used by the completion call to confirm the object landed and enforce the declared size.
- Bucket bootstrap (dev/test): `CreateBucketCommand` guarded by `HeadBucketCommand` (idempotent ensure-bucket).

### @aws-sdk/s3-request-presigner

- **Used by:** TD-02 (part upload URLs), TD-08 (stream/download URLs).
- `getSignedUrl(client, command, { expiresIn })` — works with `UploadPartCommand` (PUT part), `GetObjectCommand` (stream), and `GetObjectCommand` with `ResponseContentDisposition: 'attachment; filename="..."'` (download). `expiresIn` in seconds (3600 = 1h per TD-02/TD-08 revisions).
- Presigned URLs embed the client's endpoint — for browser access the S3 endpoint must be reachable from the host (MinIO port published in Compose; `S3_PUBLIC_ENDPOINT` env when the internal Docker hostname differs from the host-visible one).
- Range requests (`206 Partial Content`) are served natively by S3/MinIO on the presigned GET — no extra signing work for streaming/seek.

### nanoid

- **Used by:** TD-05 (unique URL id).
- **Version pin: `nanoid@3` (e.g., ^3.3.8).** v4+ is ESM-only and cannot be `require()`d from the project's CommonJS output (`ts-node`/`ts-jest`); v3 keeps the same core API and receives security maintenance.
- API: `import { nanoid } from 'nanoid'` → `nanoid(11)` generates an 11-char URL-safe id (`A-Za-z0-9_-`). Collision probability at 11 chars is negligible for this domain; the DB unique index on `url_id` + a single retry on unique-violation makes conflicts impossible by construction (TD-05).
