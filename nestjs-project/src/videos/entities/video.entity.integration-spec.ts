import { DataSource, Repository } from 'typeorm';
import { QueryFailedError } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  const baseVideo = (overrides: Partial<Video> = {}): Partial<Video> => ({
    channel_id: channel.id,
    title: 'My first video',
    url_id: `vid_${Math.random().toString(36).slice(2, 9)}`,
    storage_key: 'videos/x/original.mp4',
    content_type: 'video/mp4',
    original_filename: 'movie.mp4',
    size_bytes: '1048576',
    ...overrides,
  });

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `owner-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${Math.random().toString(36).slice(2, 8)}`,
      user_id: user.id,
    });
  });

  it('persists with status defaulting to draft', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(baseVideo()),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
  });

  it('enforces the unique constraint on url_id', async () => {
    await videoRepository.save(
      videoRepository.create(baseVideo({ url_id: 'duplicated_1' })),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(baseVideo({ url_id: 'duplicated_1' })),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('enforces the FK to channels', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create(
          baseVideo({
            channel_id: '00000000-0000-0000-0000-000000000000',
          }),
        ),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('round-trips jsonb metadata', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      codec: 'h264',
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
      sizeBytes: 1048576,
    };
    const saved = await videoRepository.save(
      videoRepository.create(
        baseVideo({ metadata, status: VideoStatus.READY }),
      ),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
    expect(found.status).toBe(VideoStatus.READY);
  });

  it('loads the channel relation', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(baseVideo()),
    );

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });
    expect(found.channel.id).toBe(channel.id);
  });
});
