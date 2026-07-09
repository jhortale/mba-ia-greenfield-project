import { QueryFailedError } from 'typeorm';
import {
  NotVideoOwnerException,
  UploadIncompleteException,
  UploadNotInProgressException,
  VideoNotFoundException,
  VideoNotReadyException,
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
    save: jest.fn((v: any) => Promise.resolve(v as Video)),
    findOne: jest.fn(),
  };
  const channels = overrides.channels ?? {
    findByUserId: jest.fn(() => Promise.resolve({ id: 'channel-1' })),
  };
  const storage = overrides.storage ?? {
    createMultipartUpload: jest.fn(() => Promise.resolve('upload-1')),
    presignUploadPart: jest.fn((_k: string, _u: string, n: number) =>
      Promise.resolve(`https://signed/${n}`),
    ),
    abortMultipartUpload: jest.fn(() => Promise.resolve(undefined)),
  };
  const producer = overrides.producer ?? {
    enqueueProcessVideo: jest.fn(() => Promise.resolve(undefined)),
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
        .mockImplementation((v: any) => {
          saved.push(v);
          return Promise.resolve(v as Video);
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
    const repo = { findOne: jest.fn(() => Promise.resolve(null)) };
    const { service } = makeService({ repo });

    await expect(
      service.requestPartUrls('user-1', 'nope', { partNumbers: [1] }),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('throws NotVideoOwnerException when the caller does not own the video', async () => {
    const repo = { findOne: jest.fn(() => Promise.resolve(makeVideo())) };
    const { service } = makeService({ repo });

    await expect(
      service.requestPartUrls('intruder', 'video-1', { partNumbers: [1] }),
    ).rejects.toThrow(NotVideoOwnerException);
  });

  it('throws UploadNotInProgressException when the video is not a draft', async () => {
    const repo = {
      findOne: jest.fn(() =>
        Promise.resolve(
          makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
        ),
      ),
    };
    const { service } = makeService({ repo });

    await expect(
      service.requestPartUrls('user-1', 'video-1', { partNumbers: [1] }),
    ).rejects.toThrow(UploadNotInProgressException);
  });

  it('rejects part numbers outside the computed range', async () => {
    const repo = { findOne: jest.fn(() => Promise.resolve(makeVideo())) };
    const { service } = makeService({ repo });

    await expect(
      // 250 MiB → 3 parts; part 4 is out of range
      service.requestPartUrls('user-1', 'video-1', { partNumbers: [4] }),
    ).rejects.toThrow(UploadNotInProgressException);
  });

  it('re-issues URLs for the requested parts', async () => {
    const repo = { findOne: jest.fn(() => Promise.resolve(makeVideo())) };
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

describe('VideosService — completeUpload', () => {
  const parts = { parts: [{ partNumber: 1, etag: '"e1"' }] };

  function makeCompleteStorage(overrides: Record<string, any> = {}) {
    return {
      completeMultipartUpload: jest.fn(() => Promise.resolve(undefined)),
      headObject: jest.fn(() =>
        Promise.resolve({ sizeBytes: 250 * 1024 ** 2 }),
      ),
      deleteObject: jest.fn(() => Promise.resolve(undefined)),
      ...overrides,
    };
  }

  it('flips the video to processing and enqueues exactly one job', async () => {
    const video = makeVideo();
    const repo = {
      findOne: jest.fn(() => Promise.resolve(video)),
      save: jest.fn((v: any) => Promise.resolve(v as Video)),
    };
    const storage = makeCompleteStorage();
    const { service, producer } = makeService({ repo, storage });

    const result = await service.completeUpload('user-1', 'video-1', parts);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(result.upload_id).toBeNull();
    expect(producer.enqueueProcessVideo).toHaveBeenCalledTimes(1);
    expect(producer.enqueueProcessVideo).toHaveBeenCalledWith('video-1');
  });

  it('throws UploadNotInProgressException on double completion', async () => {
    const repo = {
      findOne: jest.fn(() =>
        Promise.resolve(
          makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
        ),
      ),
    };
    const { service, producer } = makeService({
      repo,
      storage: makeCompleteStorage(),
    });

    await expect(
      service.completeUpload('user-1', 'video-1', parts),
    ).rejects.toThrow(UploadNotInProgressException);
    expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
  });

  it('does not flip status when the stored size mismatches the declared size', async () => {
    const video = makeVideo();
    const repo = {
      findOne: jest.fn(() => Promise.resolve(video)),
      save: jest.fn((v: any) => Promise.resolve(v as Video)),
    };
    const storage = makeCompleteStorage({
      headObject: jest.fn(() => Promise.resolve({ sizeBytes: 1 })),
    });
    const { service, producer } = makeService({ repo, storage });

    await expect(
      service.completeUpload('user-1', 'video-1', parts),
    ).rejects.toThrow(UploadIncompleteException);
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(storage.deleteObject).toHaveBeenCalledWith(video.storage_key);
    expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
  });

  it('maps storage completion failures to UploadIncompleteException', async () => {
    const repo = {
      findOne: jest.fn(() => Promise.resolve(makeVideo())),
      save: jest.fn((v: any) => Promise.resolve(v as Video)),
    };
    const storage = makeCompleteStorage({
      completeMultipartUpload: jest
        .fn()
        .mockRejectedValue(new Error('InvalidPart')),
    });
    const { service, producer } = makeService({ repo, storage });

    await expect(
      service.completeUpload('user-1', 'video-1', parts),
    ).rejects.toThrow(UploadIncompleteException);
    expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
  });
});

describe('VideosService — stream and download URLs', () => {
  function makeReadStorage() {
    return {
      presignGetObject: jest.fn(() => Promise.resolve('https://signed/get')),
    };
  }

  it('returns a stream URL for a ready video', async () => {
    const repo = {
      findOne: jest.fn(() =>
        Promise.resolve(
          makeVideo({ status: VideoStatus.READY, upload_id: null }),
        ),
      ),
    };
    const storage = makeReadStorage();
    const { service } = makeService({ repo, storage });

    const result = await service.getStreamUrl('url_abc1234');

    expect(result).toEqual({
      url: 'https://signed/get',
      expiresInSeconds: 3600,
    });
    expect(storage.presignGetObject).toHaveBeenCalledWith(
      'videos/video-1/original.mp4',
    );
  });

  it('passes the original filename as attachment for downloads', async () => {
    const repo = {
      findOne: jest.fn(() =>
        Promise.resolve(
          makeVideo({ status: VideoStatus.READY, upload_id: null }),
        ),
      ),
    };
    const storage = makeReadStorage();
    const { service } = makeService({ repo, storage });

    await service.getDownloadUrl('url_abc1234');

    expect(storage.presignGetObject).toHaveBeenCalledWith(
      'videos/video-1/original.mp4',
      { downloadFilename: 'movie.mp4' },
    );
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
    'throws VideoNotReadyException for %s videos',
    async (status) => {
      const repo = {
        findOne: jest.fn(() => Promise.resolve(makeVideo({ status }))),
      };
      const { service } = makeService({ repo, storage: makeReadStorage() });

      await expect(service.getStreamUrl('url_abc1234')).rejects.toThrow(
        VideoNotReadyException,
      );
      await expect(service.getDownloadUrl('url_abc1234')).rejects.toThrow(
        VideoNotReadyException,
      );
    },
  );

  it('returns a thumbnail URL only when the key exists', async () => {
    const { service } = makeService({ storage: makeReadStorage() });

    expect(
      await service.getThumbnailUrl(makeVideo({ thumbnail_key: null })),
    ).toBeNull();
    expect(
      await service.getThumbnailUrl(
        makeVideo({ thumbnail_key: 'thumbnails/video-1.jpg' }),
      ),
    ).toBe('https://signed/get');
  });

  it('throws VideoNotFoundException for an unknown urlId', async () => {
    const repo = { findOne: jest.fn(() => Promise.resolve(null)) };
    const { service } = makeService({ repo });

    await expect(service.findByUrlId('missing')).rejects.toThrow(
      VideoNotFoundException,
    );
  });
});

describe('VideosService — cleanupAbandonedUploads', () => {
  const NOW = new Date('2026-07-09T12:00:00Z');

  it('reclaims only drafts older than 24h with a pending upload', async () => {
    const stale = makeVideo({ id: 'stale' });
    const repo = {
      find: jest.fn(() => Promise.resolve([stale])),
      delete: jest.fn(() => Promise.resolve(undefined)),
      findOne: jest.fn(),
    };
    const storage = {
      abortMultipartUpload: jest.fn(() => Promise.resolve(undefined)),
    };
    const { service } = makeService({ repo, storage });

    const count = await service.cleanupAbandonedUploads(NOW);

    expect(count).toBe(1);
    const where = (repo.find as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe(VideoStatus.DRAFT);
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      stale.storage_key,
      stale.upload_id,
    );
    expect(repo.delete).toHaveBeenCalledWith({ id: 'stale' });
  });

  it('still deletes the row when the storage abort fails', async () => {
    const stale = makeVideo({ id: 'stale' });
    const repo = {
      find: jest.fn(() => Promise.resolve([stale])),
      delete: jest.fn(() => Promise.resolve(undefined)),
      findOne: jest.fn(),
    };
    const storage = {
      abortMultipartUpload: jest
        .fn()
        .mockRejectedValue(new Error('NoSuchUpload')),
    };
    const { service } = makeService({ repo, storage });

    const count = await service.cleanupAbandonedUploads(NOW);

    expect(count).toBe(1);
    expect(repo.delete).toHaveBeenCalledWith({ id: 'stale' });
  });
});
