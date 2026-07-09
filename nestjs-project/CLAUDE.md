# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `curl -sf http://localhost:9000/minio/health/live` — expect HTTP 200
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — video processing worker (BullMQ consumer + FFmpeg), no exposed port
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — S3-compatible object storage, API port `9000`, console `9001` (videos and thumbnails, bucket `streamtube-videos`)
- `redis` — Redis 7, port `6379` (BullMQ queue backend)
- `mailpit` — SMTP capture, ports `1025`/`8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/ (emits main and worker-main entrypoints)
npm run start:prod                       # Run compiled build
npm run start:worker                     # Video worker (BullMQ consumer) — runs in the video-worker container
npm run start:worker:dev                 # Video worker in watch mode (the video-worker container's default command)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # maxWorkers: 1 in test/jest-e2e.json
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

**Worker/FFmpeg tests:** `src/worker/video.processor.integration-spec.ts` needs the real `ffmpeg`/`ffprobe` binaries and therefore runs inside the **video-worker** container (in `nestjs-api` it self-skips with a warning):

```bash
docker compose exec video-worker npm test -- --runInBand --forceExit src/worker/video.processor.integration-spec.ts
```

The full-lifecycle videos E2E requires the `video-worker` container running — the test uploads a real file and waits for the live worker to process it.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos Module (Phase 03)

Video upload and processing pipeline. Key design decisions live in `docs/decisions/technical-decisions-phase-03-videos.md`; the executable plan in `docs/phases/phase-03-videos/`.

- **Upload:** presigned S3 multipart direct to MinIO — the API only issues URLs (100 MiB parts, 10 GiB ceiling validated at initiation). The video is pre-registered as a `draft` row when the upload starts.
- **Endpoints (`src/videos/`):** `POST /videos/uploads` (initiate), `POST /videos/:videoId/upload/part-urls` (re-issue URLs for resume), `POST /videos/:videoId/upload/complete` (verify object + enqueue processing), `GET /videos/:urlId` (details + presigned thumbnail), `GET /videos/:urlId/stream-url`, `GET /videos/:urlId/download-url`. All require authentication; upload mutations are owner-only.
- **Queue (`src/queue/`):** BullMQ queue `video-processing` over Redis; jobs carry only `{ videoId }` with `attempts: 3` + exponential backoff.
- **Worker (`src/worker/` + `src/worker-main.ts`):** separate container (`Dockerfile.worker`, FFmpeg installed) consuming the queue via `@Processor`; `ffprobe` extracts duration/metadata and `ffmpeg` captures the thumbnail frame reading the source **by URL** from storage (no local download). Status lifecycle `draft → processing → ready | failed` — on final attempt failure the row gets `failed` + `error_message`.
- **Storage (`src/storage/`):** single private bucket, keys `videos/{id}/original{ext}` and `thumbnails/{id}.jpg`; all access via presigned URLs. `StorageService` keeps two S3 clients: internal endpoint (SDK ops, worker presigns) and `S3_PUBLIC_ENDPOINT` (presigns usable by browsers on the host). Tests running inside containers override `S3_PUBLIC_ENDPOINT` to `http://minio:9000`.
- **Streaming/download:** presigned GET served directly by MinIO/S3 — Range/`206 Partial Content` is native; download adds `Content-Disposition: attachment`. Available to any authenticated user for `ready` videos (`VIDEO_NOT_READY` otherwise).
- **Cleanup:** `VideosService.cleanupAbandonedUploads()` reclaims drafts older than 24h (aborts the multipart upload + deletes the row). No scheduled sweep yet — deliberate deferral.
- **Env vars:** `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT` (validated in `src/config/env.validation.ts`; namespaces `storage`/`queue` in `src/config/`).
