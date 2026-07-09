import { Job } from 'bullmq';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessor, thumbnailCaptureSecond } from './video.processor';

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-1';
  video.status = VideoStatus.PROCESSING;
  video.storage_key = 'videos/video-1/original.mp4';
  return Object.assign(video, overrides);
}

function makeDeps(overrides: {
  repo?: any;
  storage?: any;
  ffmpeg?: any;
}) {
  const repo = overrides.repo ?? {
    findOneBy: jest.fn(async () => makeVideo()),
    save: jest.fn(async (v: any) => v),
    update: jest.fn(async () => undefined),
  };
  const storage = overrides.storage ?? {
    presignGetObject: jest.fn(async () => 'http://minio:9000/signed'),
    putObject: jest.fn(async () => undefined),
  };
  const ffmpeg = overrides.ffmpeg ?? {
    probe: jest.fn(async () => ({
      durationSeconds: 42,
      width: 1280,
      height: 720,
      codec: 'h264',
      format: 'mp4',
      sizeBytes: 2048,
    })),
    captureFrame: jest.fn(async () => Buffer.from([0xff, 0xd8])),
  };
  return {
    processor: new VideoProcessor(repo, storage, ffmpeg),
    repo,
    storage,
    ffmpeg,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    data: { videoId: 'video-1' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job;
}

describe('thumbnailCaptureSecond', () => {
  it('captures at second 1 for videos of 10s or longer', () => {
    expect(thumbnailCaptureSecond(10)).toBe(1);
    expect(thumbnailCaptureSecond(3600)).toBe(1);
  });

  it('captures at 10% of duration for shorter videos', () => {
    expect(thumbnailCaptureSecond(5)).toBeCloseTo(0.5);
    expect(thumbnailCaptureSecond(0)).toBe(0);
  });
});

describe('VideoProcessor — process', () => {
  it('extracts metadata, stores the thumbnail and marks the video ready', async () => {
    const video = makeVideo();
    const repo = {
      findOneBy: jest.fn(async () => video),
      save: jest.fn(async (v: any) => v),
      update: jest.fn(),
    };
    const { processor, storage, ffmpeg } = makeDeps({ repo });

    await processor.process(makeJob());

    expect(storage.presignGetObject).toHaveBeenCalledWith(
      video.storage_key,
      { internal: true },
    );
    expect(ffmpeg.probe).toHaveBeenCalledWith('http://minio:9000/signed');
    expect(storage.putObject).toHaveBeenCalledWith(
      'thumbnails/video-1.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBe(42);
    expect(video.metadata).toEqual({
      width: 1280,
      height: 720,
      codec: 'h264',
      format: 'mp4',
      sizeBytes: 2048,
    });
    expect(video.thumbnail_key).toBe('thumbnails/video-1.jpg');
    expect(video.error_message).toBeNull();
  });

  it('skips silently when the video row no longer exists', async () => {
    const repo = {
      findOneBy: jest.fn(async () => null),
      save: jest.fn(),
      update: jest.fn(),
    };
    const { processor, ffmpeg } = makeDeps({ repo });

    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    expect(ffmpeg.probe).not.toHaveBeenCalled();
  });

  it('propagates ffmpeg errors so BullMQ can retry', async () => {
    const ffmpeg = {
      probe: jest.fn().mockRejectedValue(new Error('corrupt file')),
      captureFrame: jest.fn(),
    };
    const { processor } = makeDeps({ ffmpeg });

    await expect(processor.process(makeJob())).rejects.toThrow('corrupt file');
  });
});

describe('VideoProcessor — onFailed', () => {
  it('does nothing before the final attempt', async () => {
    const { processor, repo } = makeDeps({});

    await processor.onFailed(
      makeJob({ attemptsMade: 1 }),
      new Error('transient'),
    );

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('marks the video failed with the error message on the final attempt', async () => {
    const { processor, repo } = makeDeps({});

    await processor.onFailed(
      makeJob({ attemptsMade: 3 }),
      new Error('ffprobe exploded'),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      { status: VideoStatus.FAILED, error_message: 'ffprobe exploded' },
    );
  });

  it('never rethrows when the failure update itself fails', async () => {
    const repo = {
      findOneBy: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const { processor } = makeDeps({ repo });

    await expect(
      processor.onFailed(makeJob({ attemptsMade: 3 }), new Error('x')),
    ).resolves.toBeUndefined();
  });
});
