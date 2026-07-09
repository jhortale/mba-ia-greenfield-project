import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
