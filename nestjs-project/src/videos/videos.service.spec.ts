import { QueryFailedError } from 'typeorm';
import {
  NotVideoOwnerException,
  UploadNotInProgressException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { UPLOAD_PART_SIZE_BYTES } from './videos.constants';

function makeUniqueUrlIdError(): QueryFailedError {
  const driverError = new Error() as any;
  driverError.code = '23505';
  driverError.detail = 'Key (url_id)=(abc) already exists.';
  return new QueryFailedError('INSERT', [], driverError);
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-1';
  video.channel_id = 'channel-1';
  video.title = 'My video';
  video.url_id = 'url_abc1234';
  video.status = VideoStatus.DRAFT;
  video.storage_key = 'videos/video-1/original.mp4';
  video.upload_id = 'upload-1';
  video.content_type = 'video/mp4';
  video.original_filename = 'movie.mp4';
  video.size_bytes = String(250 * 1024 ** 2);
  video.channel = { id: 'channel-1', user_id: 'user-1' } as any;
  return Object.assign(video, overrides);
}

function makeService(overrides: {
  repo?: any;
  channels?: any;
  storage?: any;
  producer?: any;
}) {
  const repo = overrides.repo ?? {
    create: jest.fn((v: any) => v),
    save: jest.fn(async (v: any) => v as Video),
    findOne: jest.fn(),
  };
  const channels = overrides.channels ?? {
    findByUserId: jest.fn(async () => ({ id: 'channel-1' })),
  };
  const storage = overrides.storage ?? {
    createMultipartUpload: jest.fn(async () => 'upload-1'),
    presignUploadPart: jest.fn(
      async (_k: string, _u: string, n: number) => `https://signed/${n}`,
    ),
    abortMultipartUpload: jest.fn(async () => undefined),
  };
  const producer = overrides.producer ?? {
    enqueueProcessVideo: jest.fn(async () => undefined),
  };
  return {
    service: new VideosService(repo, channels, storage, producer),
    repo,
    channels,
    storage,
    producer,
  };
}

describe('VideosService — initiateUpload', () => {
  const dto = {
    filename: 'movie.mp4',
    contentType: 'video/mp4',
    sizeBytes: 250 * 1024 ** 2, // 250 MiB → 3 parts
  };

  it('creates a draft with presigned URLs for every part', async () => {
    const { service, storage } = makeService({});

    const result = await service.initiateUpload('user-1', dto as any);

    expect(result.upload.partCount).toBe(3);
    expect(result.upload.partSizeBytes).toBe(UPLOAD_PART_SIZE_BYTES);
    expect(result.upload.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(storage.createMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/.+\/original\.mp4$/),
      'video/mp4',
    );
  });

  it('defaults the title to the filename without extension', async () => {
    const { service, repo } = makeService({});

    await service.initiateUpload('user-1', dto as any);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'movie' }),
    );
  });

  it('retries once with a new url_id on unique violation', async () => {
    const saved: any[] = [];
    const repo = {
      create: jest.fn((v: any) => v),
      save: jest
        .fn()
        .mockRejectedValueOnce(makeUniqueUrlIdError())
        .mockImplementation(async (v: any) => {
          saved.push(v);
          return v as Video;
        }),
      findOne: jest.fn(),
    };
    const { service, repo: usedRepo } = makeService({ repo });

    await service.initiateUpload('user-1', dto as any);

    expect(usedRepo.save).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = (usedRepo.create as jest.Mock).mock.calls;
    expect(firstCall[0].url_id).not.toBe(secondCall[0].url_id);
  });

  it('aborts the multipart upload when the draft insert ultimately fails', async () => {
    const repo = {
      create: jest.fn((v: any) => v),
      save: jest.fn().mockRejectedValue(new Error('db down')),
      findOne: jest.fn(),
    };
    const { service, storage } = makeService({ repo });

    await expect(service.initiateUpload('user-1', dto as any)).rejects.toThrow(
      'db down',
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalled();
  });
});

describe('VideosService — requestPartUrls', () => {
  it('throws VideoNotFoundException for an unknown video', async () => {
    const repo = { findOne: jest.fn(async () => null) };
    const { service } = makeService({ repo });

    await expect(
      service.requestPartUrls('user-1', 'nope', { partNumbers: [1] }),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('throws NotVideoOwnerException when the caller does not own the video', async () => {
    const repo = { findOne: jest.fn(async () => makeVideo()) };
    const { service } = makeService({ repo });

    await expect(
      service.requestPartUrls('intruder', 'video-1', { partNumbers: [1] }),
    ).rejects.toThrow(NotVideoOwnerException);
  });

  it('throws UploadNotInProgressException when the video is not a draft', async () => {
    const repo = {
      findOne: jest.fn(async () =>
        makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      ),
    };
    const { service } = makeService({ repo });

    await expect(
      service.requestPartUrls('user-1', 'video-1', { partNumbers: [1] }),
    ).rejects.toThrow(UploadNotInProgressException);
  });

  it('rejects part numbers outside the computed range', async () => {
    const repo = { findOne: jest.fn(async () => makeVideo()) };
    const { service } = makeService({ repo });

    await expect(
      // 250 MiB → 3 parts; part 4 is out of range
      service.requestPartUrls('user-1', 'video-1', { partNumbers: [4] }),
    ).rejects.toThrow(UploadNotInProgressException);
  });

  it('re-issues URLs for the requested parts', async () => {
    const repo = { findOne: jest.fn(async () => makeVideo()) };
    const { service } = makeService({ repo });

    const parts = await service.requestPartUrls('user-1', 'video-1', {
      partNumbers: [2, 3],
    });

    expect(parts).toEqual([
      { partNumber: 2, url: 'https://signed/2' },
      { partNumber: 3, url: 'https://signed/3' },
    ]);
  });
});
