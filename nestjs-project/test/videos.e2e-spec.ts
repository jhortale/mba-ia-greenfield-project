import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

// E2E runs inside the container — presigned URLs must target the in-network
// MinIO hostname, not the host-facing endpoint.
process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';

const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerAndLogin(
    email: string,
  ): Promise<{ accessToken: string }> {
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return { accessToken: login.body.access_token as string };
  }

  const initiateBody = {
    filename: 'movie.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1024,
  };

  function initiate(
    accessToken: string,
    body: Record<string, unknown> = initiateBody,
  ) {
    return request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  describe('POST /videos/uploads', () => {
    it('returns 201 with a draft video and presigned part URLs', async () => {
      const { accessToken } = await registerAndLogin('up1@example.com');

      const response = await initiate(accessToken).expect(201);

      expect(response.body.video).toMatchObject({
        title: 'movie',
        status: 'draft',
      });
      expect(response.body.video.urlId).toHaveLength(11);
      expect(response.body.upload.partSizeBytes).toBe(100 * 1024 ** 2);
      expect(response.body.upload.partCount).toBe(1);
      expect(response.body.upload.parts).toHaveLength(1);
      expect(response.body.upload.parts[0].url).toContain('minio:9000');

      // Draft pre-registration is persisted immediately.
      const row = await videoRepository.findOneByOrFail({
        id: response.body.video.id,
      });
      expect(row.status).toBe(VideoStatus.DRAFT);
    });

    it('returns 400 when sizeBytes exceeds the 10GB limit', async () => {
      const { accessToken } = await registerAndLogin('up2@example.com');

      const response = await initiate(accessToken, {
        ...initiateBody,
        sizeBytes: MAX_VIDEO_SIZE_BYTES + 1,
      }).expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for a non-video contentType', async () => {
      const { accessToken } = await registerAndLogin('up3@example.com');

      const response = await initiate(accessToken, {
        ...initiateBody,
        contentType: 'application/pdf',
      }).expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send(initiateBody)
        .expect(401);
    });
  });

  describe('POST /videos/:videoId/upload/complete', () => {
    it('completes a real multipart upload and enqueues processing', async () => {
      const { accessToken } = await registerAndLogin('complete1@example.com');
      const created = await initiate(accessToken).expect(201);

      const put = await fetch(created.body.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(1024, 5),
      });
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag')!;

      const response = await request(app.getHttpServer())
        .post(`/videos/${created.body.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(200);

      expect(response.body.status).toBe('processing');

      const row = await videoRepository.findOneByOrFail({
        id: created.body.video.id,
      });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      await storage.deleteObject(row.storage_key);
    });

    it('returns 409 on double completion', async () => {
      const { accessToken } = await registerAndLogin('complete2@example.com');
      const created = await initiate(accessToken).expect(201);

      const put = await fetch(created.body.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(1024, 6),
      });
      const etag = put.headers.get('etag')!;
      const parts = { parts: [{ partNumber: 1, etag }] };

      await request(app.getHttpServer())
        .post(`/videos/${created.body.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(parts)
        .expect(200);

      const response = await request(app.getHttpServer())
        .post(`/videos/${created.body.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(parts)
        .expect(409);
      expect(response.body.error).toBe('UPLOAD_NOT_IN_PROGRESS');

      const row = await videoRepository.findOneByOrFail({
        id: created.body.video.id,
      });
      await storage.deleteObject(row.storage_key);
    });

    it('returns 403 when a non-owner tries to complete', async () => {
      const { accessToken } = await registerAndLogin('complete3@example.com');
      const created = await initiate(accessToken).expect(201);
      const { accessToken: intruderToken } = await registerAndLogin(
        'complete-intruder@example.com',
      );

      const response = await request(app.getHttpServer())
        .post(`/videos/${created.body.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .send({ parts: [{ partNumber: 1, etag: '"x"' }] })
        .expect(403);
      expect(response.body.error).toBe('NOT_VIDEO_OWNER');
    });
  });

  describe('POST /videos/:videoId/upload/part-urls', () => {
    it('re-issues part URLs for the owner', async () => {
      const { accessToken } = await registerAndLogin('owner1@example.com');
      const created = await initiate(accessToken).expect(201);

      const response = await request(app.getHttpServer())
        .post(`/videos/${created.body.video.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ partNumbers: [1] })
        .expect(200);

      expect(response.body.parts).toHaveLength(1);
    });

    it('returns 403 for a non-owner', async () => {
      const { accessToken } = await registerAndLogin('owner2@example.com');
      const created = await initiate(accessToken).expect(201);
      const { accessToken: intruderToken } =
        await registerAndLogin('intruder@example.com');

      const response = await request(app.getHttpServer())
        .post(`/videos/${created.body.video.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .send({ partNumbers: [1] })
        .expect(403);

      expect(response.body.error).toBe('NOT_VIDEO_OWNER');
    });

    it('returns 409 when there is no upload in progress', async () => {
      const { accessToken } = await registerAndLogin('owner3@example.com');
      const created = await initiate(accessToken).expect(201);
      await videoRepository.update(created.body.video.id, {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });

      const response = await request(app.getHttpServer())
        .post(`/videos/${created.body.video.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ partNumbers: [1] })
        .expect(409);

      expect(response.body.error).toBe('UPLOAD_NOT_IN_PROGRESS');
    });

    it('returns 404 for an unknown video id', async () => {
      const { accessToken } = await registerAndLogin('owner4@example.com');

      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/upload/part-urls')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ partNumbers: [1] })
        .expect(404);
    });
  });

  describe('full lifecycle: upload → worker processing → stream/download', () => {
    // Requires the video-worker container running (docker compose up -d):
    // the job is consumed by the real worker with real ffmpeg.
    jest.setTimeout(90_000);

    const fixture = readFileSync(join(__dirname, 'fixtures', 'sample-2s.mp4'));

    async function waitUntilProcessed(videoId: string): Promise<Video> {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const row = await videoRepository.findOneByOrFail({ id: videoId });
        if (
          row.status === VideoStatus.READY ||
          row.status === VideoStatus.FAILED
        ) {
          return row;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Video ${videoId} still ${row.status} after 60s — is the video-worker container running?`,
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    it('processes a real video end-to-end and serves streaming/download URLs', async () => {
      const { accessToken } = await registerAndLogin('lifecycle@example.com');

      // 1. Initiate: draft pre-registered, part URLs issued.
      const created = await initiate(accessToken, {
        filename: 'sample-2s.mp4',
        contentType: 'video/mp4',
        sizeBytes: fixture.length,
      }).expect(201);
      const videoId = created.body.video.id as string;
      const urlId = created.body.video.urlId as string;

      // 2. Upload the real bytes through the presigned URL.
      const put = await fetch(created.body.upload.parts[0].url, {
        method: 'PUT',
        body: fixture,
      });
      expect(put.status).toBe(200);

      // 3. Complete: status flips to processing, job enqueued.
      await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag: put.headers.get('etag')! }] })
        .expect(200);

      // 4. The real worker (separate container) processes automatically.
      const processed = await waitUntilProcessed(videoId);
      expect(processed.status).toBe(VideoStatus.READY);
      expect(processed.duration_seconds).toBe(2);
      expect(processed.metadata).toMatchObject({ width: 320, height: 240 });

      // 5. Details expose metadata and a presigned thumbnail URL.
      const details = await request(app.getHttpServer())
        .get(`/videos/${urlId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(details.body.status).toBe('ready');
      expect(details.body.durationSeconds).toBe(2);
      expect(details.body.thumbnailUrl).toBeTruthy();
      const thumb = await fetch(details.body.thumbnailUrl);
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get('content-type')).toBe('image/jpeg');

      // 6. Streaming: presigned URL served by storage with Range/206 —
      //    playback does not require downloading the whole file.
      const streamUrl = await request(app.getHttpServer())
        .get(`/videos/${urlId}/stream-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const ranged = await fetch(streamUrl.body.url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${fixture.length}`,
      );

      // 7. Download: attachment disposition with the original filename.
      const downloadUrl = await request(app.getHttpServer())
        .get(`/videos/${urlId}/download-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const download = await fetch(downloadUrl.body.url);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toBe(
        'attachment; filename="sample-2s.mp4"',
      );
      const downloaded = Buffer.from(await download.arrayBuffer());
      expect(downloaded.equals(fixture)).toBe(true);

      // 8. Any authenticated user (not only the owner) can stream it.
      const { accessToken: viewerToken } =
        await registerAndLogin('viewer@example.com');
      await request(app.getHttpServer())
        .get(`/videos/${urlId}/stream-url`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);

      // Cleanup storage objects.
      const row = await videoRepository.findOneByOrFail({ id: videoId });
      await storage.deleteObject(row.storage_key);
      await storage.deleteObject(row.thumbnail_key!);
    });

    it('returns 409 VIDEO_NOT_READY while the video is a draft', async () => {
      const { accessToken } = await registerAndLogin('notready@example.com');
      const created = await initiate(accessToken).expect(201);

      const response = await request(app.getHttpServer())
        .get(`/videos/${created.body.video.urlId}/stream-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
      expect(response.body.error).toBe('VIDEO_NOT_READY');

      await request(app.getHttpServer())
        .get(`/videos/${created.body.video.urlId}/download-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
    });

    it('returns 404 for an unknown urlId', async () => {
      const { accessToken } = await registerAndLogin('unknown@example.com');

      await request(app.getHttpServer())
        .get('/videos/does-not-exist/stream-url')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .get('/videos/does-not-exist')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });
  });
});
