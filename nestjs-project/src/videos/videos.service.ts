import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { nanoid } from 'nanoid';
import {
  NotVideoOwnerException,
  UploadIncompleteException,
  UploadNotInProgressException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { videoKey } from '../storage/storage.constants';
import { VideoQueueProducer } from '../queue/video-queue.producer';
import { Video, VideoStatus } from './entities/video.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import {
  UPLOAD_PART_SIZE_BYTES,
  URL_ID_LENGTH,
} from './videos.constants';

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface InitiateUploadResult {
  video: Video;
  upload: {
    partSizeBytes: number;
    partCount: number;
    parts: PresignedPart[];
  };
}

const URL_ID_COLUMN = 'url_id';
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err.driverError as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

function sanitizedExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return /^\.[a-z0-9]+$/.test(ext) ? ext : '';
}

function titleFromFilename(filename: string): string {
  const ext = extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return base || filename;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueProducer: VideoQueueProducer,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Phase 02 invariant: every user has a channel created at registration.
      throw new Error(`User ${userId} has no channel`);
    }

    const videoId = randomUUID();
    const storageKey = videoKey(videoId, sanitizedExtension(dto.filename));
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.saveDraftWithUniqueUrlId({
        id: videoId,
        channel_id: channel.id,
        title: dto.title ?? titleFromFilename(dto.filename),
        storage_key: storageKey,
        upload_id: uploadId,
        content_type: dto.contentType,
        original_filename: dto.filename,
        size_bytes: String(dto.sizeBytes),
      });
    } catch (err) {
      // Do not leak a pending multipart upload when the draft insert fails.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    const partCount = this.partCountFor(dto.sizeBytes);
    const parts = await this.presignParts(
      storageKey,
      uploadId,
      Array.from({ length: partCount }, (_, i) => i + 1),
    );

    return {
      video,
      upload: { partSizeBytes: UPLOAD_PART_SIZE_BYTES, partCount, parts },
    };
  }

  async requestPartUrls(
    userId: string,
    videoId: string,
    dto: RequestPartUrlsDto,
  ): Promise<PresignedPart[]> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadNotInProgressException();
    }

    const partCount = this.partCountFor(Number(video.size_bytes));
    const invalid = dto.partNumbers.some((n) => n < 1 || n > partCount);
    if (invalid) {
      throw new UploadNotInProgressException();
    }

    return this.presignParts(
      video.storage_key,
      video.upload_id,
      dto.partNumbers,
    );
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadNotInProgressException();
    }

    const parts = dto.parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        parts,
      );
    } catch {
      throw new UploadIncompleteException();
    }

    const head = await this.storageService.headObject(video.storage_key);
    if (!head || head.sizeBytes !== Number(video.size_bytes)) {
      // The assembled object does not match the declared size — reclaim it
      // and keep the draft so the client can restart the upload.
      await this.storageService.deleteObject(video.storage_key);
      video.upload_id = null;
      await this.videoRepository.save(video);
      throw new UploadIncompleteException();
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    // Enqueue after the commit: the DB status is the source of truth and the
    // job payload only carries the id (worker re-reads the row).
    await this.videoQueueProducer.enqueueProcessVideo(saved.id);
    return saved;
  }

  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new NotVideoOwnerException();
    }
    return video;
  }

  private partCountFor(sizeBytes: number): number {
    return Math.max(1, Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES));
  }

  private async presignParts(
    storageKey: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          storageKey,
          uploadId,
          partNumber,
        ),
      })),
    );
  }

  private async saveDraftWithUniqueUrlId(
    draft: Partial<Video>,
  ): Promise<Video> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...draft,
            url_id: nanoid(URL_ID_LENGTH),
          }),
        );
      } catch (err) {
        // nanoid collision is nearly impossible; one retry covers it (TD-05).
        if (!isUniqueViolationOnColumn(err, URL_ID_COLUMN) || attempt >= 1) {
          throw err;
        }
      }
    }
  }
}
