import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import type { ProcessVideoJobData } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { thumbnailKey } from '../storage/storage.constants';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { THUMBNAIL_CAPTURE_SECOND } from '../videos/videos.constants';
import { FfmpegService } from './ffmpeg.service';

const SHORT_VIDEO_THRESHOLD_SECONDS = 10;

export function thumbnailCaptureSecond(durationSeconds: number): number {
  // TD-04 revision: frame at second 1, or 10% of duration for videos < 10s.
  if (durationSeconds < SHORT_VIDEO_THRESHOLD_SECONDS) {
    return Math.max(0, durationSeconds * 0.1);
  }
  return THUMBNAIL_CAPTURE_SECOND;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      // Row deleted between enqueue and processing — nothing to do
      // (idempotency under at-least-once delivery).
      this.logger.warn(`Video ${job.data.videoId} not found; skipping job`);
      return;
    }

    // ffmpeg/ffprobe read the source straight from storage via presigned URL
    // (internal endpoint — the worker lives inside the Compose network).
    const sourceUrl = await this.storageService.presignGetObject(
      video.storage_key,
      { internal: true },
    );

    const probe = await this.ffmpegService.probe(sourceUrl);
    const frame = await this.ffmpegService.captureFrame(
      sourceUrl,
      thumbnailCaptureSecond(probe.durationSeconds),
    );

    const thumbKey = thumbnailKey(video.id);
    await this.storageService.putObject(thumbKey, frame, 'image/jpeg');

    video.duration_seconds = probe.durationSeconds;
    video.metadata = {
      width: probe.width,
      height: probe.height,
      codec: probe.codec,
      format: probe.format,
      sizeBytes: probe.sizeBytes,
    };
    video.thumbnail_key = thumbKey;
    video.status = VideoStatus.READY;
    video.error_message = null;
    await this.videoRepository.save(video);

    this.logger.log(`Video ${video.id} processed (ready)`);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const attempts = job.opts.attempts ?? PROCESS_VIDEO_JOB_OPTIONS.attempts;
    const isFinalAttempt = job.attemptsMade >= attempts;
    this.logger.error(
      `Processing failed for video ${job.data.videoId} (attempt ${job.attemptsMade}/${attempts}): ${error.message}`,
    );
    if (!isFinalAttempt) return;

    // Background-task context: log and persist the failure, never rethrow.
    try {
      await this.videoRepository.update(
        { id: job.data.videoId },
        { status: VideoStatus.FAILED, error_message: error.message },
      );
    } catch (updateError) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${String(updateError)}`,
      );
    }
  }
}
