import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

const execFileAsync = promisify(execFile);

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// Requires the real ffmpeg/ffprobe binaries — run inside the video-worker
// container: docker compose exec video-worker npm test -- --runInBand src/worker/video.processor.integration-spec.ts
// In containers without ffmpeg (nestjs-api) the suite is skipped explicitly.
function hasFfmpeg(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:child_process').execSync('ffprobe -version', {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const describeWithFfmpeg = hasFfmpeg() ? describe : describe.skip;
if (!hasFfmpeg()) {
  console.warn(
    'VideoProcessor (integration) SKIPPED — ffmpeg not available in this container. Run it via: docker compose exec video-worker npm test -- --runInBand src/worker/video.processor.integration-spec.ts',
  );
}

describeWithFfmpeg('VideoProcessor (integration)', () => {
  jest.setTimeout(120_000);

  let module: TestingModule;
  let processor: VideoProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let fixture: Buffer;
  let channel: Channel;

  beforeAll(async () => {
    // Generate a tiny real MP4 (2s synthetic test pattern) with ffmpeg.
    const fixturePath = join(tmpdir(), `fixture-${Date.now()}.mp4`);
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
    fixture = await readFile(fixturePath);
    await unlink(fixturePath);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessor],
    }).compile();

    processor = module.get(VideoProcessor);
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
    const user = await dataSource.getRepository(User).save({
      email: `worker-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'worker-channel',
      nickname: `worker_${Math.random().toString(36).slice(2, 8)}`,
      user_id: user.id,
    });
  });

  async function createProcessingVideo(body: Buffer): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Worker test',
        url_id: `wrk${Math.random().toString(36).slice(2, 10)}`,
        status: VideoStatus.PROCESSING,
        storage_key: `videos/worker-it-${Date.now()}/original.mp4`,
        content_type: 'video/mp4',
        original_filename: 'fixture.mp4',
        size_bytes: String(body.length),
      }),
    );
    await storage.putObject(video.storage_key, body, 'video/mp4');
    return video;
  }

  function jobFor(video: Video, attemptsMade = 1): Job {
    return {
      data: { videoId: video.id },
      attemptsMade,
      opts: { attempts: 3 },
    } as unknown as Job;
  }

  it('processes a real video: metadata extracted, thumbnail stored, status ready', async () => {
    const video = await createProcessingVideo(fixture);

    await processor.process(jobFor(video));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBe(2);
    expect(row.metadata).toMatchObject({
      width: 320,
      height: 240,
      codec: 'h264',
    });
    expect(row.metadata!.format).toContain('mp4');
    expect(row.thumbnail_key).toBe(`thumbnails/${video.id}.jpg`);

    const thumb = await storage.headObject(row.thumbnail_key!);
    expect(thumb).not.toBeNull();
    expect(thumb!.sizeBytes).toBeGreaterThan(0);

    await storage.deleteObject(row.storage_key);
    await storage.deleteObject(row.thumbnail_key!);
  });

  it('marks the video failed with the error message after the final attempt on a corrupt source', async () => {
    const video = await createProcessingVideo(
      Buffer.from('this is not a video file'),
    );

    let processingError: Error | null = null;
    try {
      await processor.process(jobFor(video));
    } catch (err) {
      processingError = err as Error;
    }
    expect(processingError).not.toBeNull();

    // Simulate BullMQ's final-attempt failure event.
    await processor.onFailed(jobFor(video, 3), processingError!);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.error_message).toBeTruthy();

    await storage.deleteObject(row.storage_key);
  });
});
