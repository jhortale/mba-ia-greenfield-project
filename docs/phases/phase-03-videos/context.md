---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-09T15:39:03-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-09T16:25:13-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-09T15:40:34-0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-09T15:40:34-0300"
  docs/phases/phase-02-auth/context.md: "2026-07-09T15:40:34-0300"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-09T15:40:34-0300"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-09T15:39:03-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** interface de vídeo no frontend (a UI de upload/watch é de fases posteriores); edição de informações do vídeo, categorias, visibilidade e fluxo rascunho→publicação (Fase 04); página de visualização com player, contagem de views e acesso anônimo (Fase 05).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (módulo de vídeos, worker de vídeo, infraestrutura Compose: object storage, fila, worker).

**Deferred subprojects:** `next-frontend/` — nenhuma tela nesta fase; os contratos cross-layer (TD-02 upload, TD-08 streaming) definem a API que o frontend consumirá em fase futura.

**Sequencing notes:** depende das Fases 01 (base) e 02 (auth/usuários/canais) — vídeos pertencem a canais (relação canal 1:1 usuário criada na Fase 02). A Fase 04 (gerenciamento) e a Fase 05 (visualização) consomem o que esta fase entrega.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — auth JWT, usuários, canais, e-mail transacional (fechada).
- **Phase 04:** Gerenciamento de Vídeos e Canal — categorias, edição de título/descrição/thumbnail customizada, visibilidade público/unlisted, rascunho→publicação, painel do canal.

## Decisions Index

_(one row per TD across phase-scope + ad-hoc docs)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Video Processing Queue Technology | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | phase | Cross-layer | 10GB Upload Strategy | decided | A (Presigned multipart) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Upload Completion Signal | decided | A (Explicit completion call) | — |
| phase-03-videos/TD-04 | phase | Backend | Worker Topology & FFmpeg Execution | decided | A + F1 (worker container; direct spawn) | — |
| phase-03-videos/TD-05 | phase | Backend | Unique Video URL Strategy | decided | A (nanoid `url_id`) | nanoid@3 |
| phase-03-videos/TD-06 | phase | Backend | Status Lifecycle & Failure Policy | decided | A (draft → processing → ready \| failed) | — |
| phase-03-videos/TD-07 | phase | Backend | Object Storage Usage (buckets/keys/access) | decided | A (single private bucket) | @aws-sdk/client-s3 |
| phase-03-videos/TD-08 | phase | Cross-layer | Streaming & Download Delivery | decided | A (presigned GET) | @aws-sdk/s3-request-presigner |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-07 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

_(current-phase TDs only)_

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — Best fit for a Node-only producer/consumer pair with heavy media jobs: official NestJS integration, first-class retries/backoff/failure events (which map directly onto the video status lifecycle in TD-06), and one small Redis container in Compose. RabbitMQ's extra semantics aren't needed for a single job type, and pg-boss contradicts the target architecture's dedicated queue container while coupling video processing load to the transactional DB.

**Libraries:** bullmq, @nestjs/bullmq

### phase-03-videos/TD-02

**Recommendation:** Option A (presigned multipart upload) — the only option that simultaneously keeps video bytes out of the API, is resumable per part, parallelizes, and needs no new infrastructure beyond the already-decided S3-compatible storage. Option C is disqualified by S3's 5GB single-PUT limit; tus adds a byte-relaying server for a problem multipart already solves.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-07-09 — Operational parameters fixed (AMB-3): part size 100 MiB; presigned part URL TTL 1h; 10 GiB ceiling enforced at upload initiation via declared total size.

### phase-03-videos/TD-03

**Recommendation:** Option A (explicit completion call) — the complete call is intrinsic to multipart upload anyway; making it the single status/enqueue trigger keeps the flow explicit, portable across MinIO/S3, and directly exercisable by the test suite. Abandoned-upload cleanup is handled as a lifecycle policy (TD-06).

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Option A + F1 — same codebase with a dedicated worker entrypoint and container (maximum reuse, single quality gate, matches the C4 diagram), spawning `ffprobe`/`ffmpeg` directly with FFmpeg installed in the worker image. FFmpeg reads the source via URL from storage, avoiding a 10GB local download for metadata/thumbnail extraction.

**Libraries:** —

**Revisions:**
- 2026-07-09 — Persisted metadata set fixed (AMB-1): duration_seconds column + `metadata` JSONB (width, height, codec, format, size_bytes); thumbnail = JPEG frame at second 1 (or 10% of duration for videos < 10s).

### phase-03-videos/TD-05

**Recommendation:** Option A (`nanoid` in `videos.url_id`) — meets "curta e única" directly, avoids PK exposure, and the unique index gives a hard non-conflict guarantee; slugs are hostile to Phase-04 title edits.

**Libraries:** nanoid@3

**Revisions:**
- 2026-07-09 — Pinned to nanoid v3.x: v4+ is ESM-only, incompatible with the project's CommonJS runtime.

### phase-03-videos/TD-06

**Recommendation:** Option A (four states: draft → processing → ready | failed) — smallest machine that satisfies the capabilities; every state has a single writer; queue-level retries (BullMQ attempts + exponential backoff) keep transient FFmpeg/storage errors out of the domain. Option B's extra states add test surface without a consumer in this phase.

**Libraries:** —

**Revisions:**
- 2026-07-09 — Abandoned-upload policy fixed (AMB-3): drafts with incomplete upload become cleanup-eligible after 24h (abort multipart + delete row); exposed as service-level maintenance operation, scheduled sweep deferred.

### phase-03-videos/TD-07

**Recommendation:** Option A (single private bucket, prefixed keys, presigned access) — smallest consistent surface; authorization centralized in the API; trivially portable to S3. Splitting/publicizing thumbnails is a Phase-05+ optimization that doesn't pay for itself before the video UI exists.

**Libraries:** @aws-sdk/client-s3

### phase-03-videos/TD-08

**Recommendation:** Option A (presigned GET, direct-from-storage) — consistent with TD-02/TD-07 and the target architecture: the API authorizes and signs; the storage serves bytes and speaks Range/206 natively. Proxying gigabytes through Node re-creates the problem the phase exists to avoid.

**Libraries:** @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-07-09 — Authorization semantics fixed (AMB-2): stream/download for any authenticated user when status `ready`; VIDEO_NOT_READY domain error otherwise; anonymous playback deferred to Phase 05. Presigned GET TTL 1h.

## Inherited Decisions Detail

_(inherited TDs from prior phases + correlator-confirmed ad-hoc docs, dedupe applied)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended choice for a greenfield project. Native build dependency is a one-time Docker setup cost.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — plugin architecture for future social login.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards with `@nestjs/jwt` only, to keep the dependency surface smaller.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — strongest security model with automatic theft detection; PostgreSQL already in the stack.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — revocability matters for reset flows; DB table is trivial.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — best NestJS integration; SMTP matches the architecture diagram; Mailpit for local dev.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — documented NestJS approach; project already uses decorators extensively.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes in `{ statusCode, error, message }` shape; two small filter files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — native NestJS guard integration; in-memory storage sufficient for single instance.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — DB lookup is mandatory anyway; opaque tokens are shorter and leak no data.

**Note:** Decision deliberately diverged from the Recommendation — JWT kept for a single token infrastructure via `@nestjs/jwt`.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — strict `[a-z0-9_]` allowlist with `user_<random>` fallback for channel nicknames.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas. _(correlator-confirmed: os novos endpoints de vídeos devem manter a documentação OpenAPI coerente)_

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + `openapi.json` exportado) — UI interativa em dev + spec commitada para codegen offline do frontend. Novos endpoints exigem re-exportar `openapi.json`.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Swagger UI apenas em dev/staging via env flag `SWAGGER_ENABLED`).

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Global `JwtAuthGuard` registered as `APP_GUARD` — every endpoint is protected by default; `@Public()` opts out. _(from phase 02)_
- Domain exceptions (never HTTP exceptions in services) mapped to `{ statusCode, error, message }` by the global domain-exception filter; validation errors normalized to the same shape. _(from phase 02)_
- Entities use snake_case column names, uuid PKs (`@PrimaryGeneratedColumn('uuid')`), `created_at`/`updated_at` timestamps; migrations generated via TypeORM CLI, never hand-written nor `synchronize`. _(from phase 02)_
- Tests: `*.spec.ts` unit (mocks only), `*.integration-spec.ts` real DB via `createTestDataSource`, `*.e2e-spec.ts` supertest in `test/`; integration/e2e run with `--runInBand`. _(from phase 02)_
- Swagger/OpenAPI documented via `@nestjs/swagger` CLI plugin; `openapi.json` re-exported when endpoints change; UI gated by `SWAGGER_ENABLED`. _(from openapi-docs-nestjs)_

## Inherited Deferred Capabilities

_(informational-only)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` was not initialized in that phase. _Delivered later by phase-02-auth-frontend._ |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces entities, services with branching + DB, services with side-effect deps (object storage, queue), modules, controllers, DTOs and a queue-consumer worker — the relevant checklist rows:

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`video.entity.ts`) | Integration: constraints, defaults |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with side-effect dep (storage, queue) | Integration: real service from Compose (MinIO, Redis) — do not mock what the Compose infra can exercise |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Queue processor (worker) | Unit: branch logic + Integration: real queue + real storage round-trip |

### next-frontend

_Deferred subproject — no UI in this phase; testing requirements will apply when the video UI phase starts._
