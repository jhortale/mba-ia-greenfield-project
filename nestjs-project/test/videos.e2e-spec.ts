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
});
