import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { StorageService } from '../storage/storage.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

// Tests run inside the container — presign against the in-network MinIO.
process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let user: User;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES).options,
        ),
        VideosModule,
      ],
    }).compile();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
    user = await dataSource.getRepository(User).save({
      email: `uploader-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: 'uploader',
      nickname: `uploader_${Math.random().toString(36).slice(2, 8)}`,
      user_id: user.id,
    });
  });

  const initiateDto = {
    filename: 'movie.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1024,
  };

  describe('initiateUpload', () => {
    it('persists the draft row and opens a real multipart upload', async () => {
      const result = await service.initiateUpload(user.id, initiateDto);

      const row = await videoRepository.findOneByOrFail({
        id: result.video.id,
      });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.url_id).toHaveLength(11);
      expect(row.upload_id).toBeTruthy();
      expect(row.storage_key).toBe(`videos/${row.id}/original.mp4`);
      expect(result.upload.partCount).toBe(1);
      expect(result.upload.parts).toHaveLength(1);

      // The presigned part URL is real and usable.
      const put = await fetch(result.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(16, 1),
      });
      expect(put.status).toBe(200);

      await storage.abortMultipartUpload(row.storage_key, row.upload_id!);
    });
  });

  describe('requestPartUrls', () => {
    it('re-issues usable URLs for pending parts', async () => {
      const { video } = await service.initiateUpload(user.id, initiateDto);

      const parts = await service.requestPartUrls(user.id, video.id, {
        partNumbers: [1],
      });

      expect(parts).toHaveLength(1);
      const put = await fetch(parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(8, 2),
      });
      expect(put.status).toBe(200);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      await storage.abortMultipartUpload(row.storage_key, row.upload_id!);
    });
  });

  describe('completeUpload', () => {
    it('stores the object, flips to processing and enqueues the job', async () => {
      const body = Buffer.alloc(1024, 3);
      const { video, upload } = await service.initiateUpload(
        user.id,
        initiateDto,
      );

      const put = await fetch(upload.parts[0].url, {
        method: 'PUT',
        body,
      });
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag')!;

      const completed = await service.completeUpload(user.id, video.id, {
        parts: [{ partNumber: 1, etag }],
      });

      expect(completed.status).toBe(VideoStatus.PROCESSING);
      expect(completed.upload_id).toBeNull();

      const head = await storage.headObject(completed.storage_key);
      expect(head).not.toBeNull();
      expect(head!.sizeBytes).toBe(1024);

      // The live video-worker container may grab the job immediately —
      // look for it in any state instead of assuming it is still waiting.
      const jobs = await queue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      ]);
      const enqueued = jobs.find((j) => j.data.videoId === video.id);
      expect(enqueued).toBeDefined();
      expect(enqueued!.name).toBe(PROCESS_VIDEO_JOB);

      await storage.deleteObject(completed.storage_key);
    });

    it('rejects a size mismatch and keeps the draft', async () => {
      const { video, upload } = await service.initiateUpload(user.id, {
        ...initiateDto,
        sizeBytes: 2048, // declared larger than what we actually upload
      });

      const put = await fetch(upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(512, 4),
      });
      const etag = put.headers.get('etag')!;

      await expect(
        service.completeUpload(user.id, video.id, {
          parts: [{ partNumber: 1, etag }],
        }),
      ).rejects.toThrow('Upload incomplete or size mismatch');

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(await storage.headObject(row.storage_key)).toBeNull();
      const jobs = await queue.getJobs(['waiting', 'active']);
      expect(jobs.filter((j) => j.data.videoId === video.id)).toHaveLength(0);
    });
  });

  describe('cleanupAbandonedUploads', () => {
    it('aborts the pending multipart upload and deletes stale drafts only', async () => {
      const stale = await service.initiateUpload(user.id, initiateDto);
      const fresh = await service.initiateUpload(user.id, initiateDto);

      // Age the stale draft beyond the 24h TTL.
      await videoRepository.update(stale.video.id, {
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });

      const count = await service.cleanupAbandonedUploads();

      expect(count).toBe(1);
      expect(
        await videoRepository.findOneBy({ id: stale.video.id }),
      ).toBeNull();
      const freshRow = await videoRepository.findOneByOrFail({
        id: fresh.video.id,
      });
      expect(freshRow.status).toBe(VideoStatus.DRAFT);

      // The stale upload is gone from storage: uploading a part to it fails.
      const put = await fetch(stale.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(8, 9),
      });
      expect(put.status).toBeGreaterThanOrEqual(400);

      await storage.abortMultipartUpload(
        freshRow.storage_key,
        freshRow.upload_id!,
      );
    });
  });
});
