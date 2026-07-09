import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import type { ProcessVideoJobData } from './queue.constants';

@Injectable()
export class VideoQueueProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueueProcessVideo(videoId: string): Promise<void> {
    // Minimal payload — the worker re-reads the row, keeping the job
    // idempotent under BullMQ's at-least-once delivery.
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      PROCESS_VIDEO_JOB_OPTIONS,
    );
  }
}
