import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { VideoQueueProducer } from './video-queue.producer';

// Runs against the real Redis service from Docker Compose (no queue mocks).
describe('VideoQueueProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoQueueProducer;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    producer = module.get(VideoQueueProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await queue.drain(true);
  });

  afterAll(async () => {
    await queue.drain(true);
    await module.close();
  });

  it('enqueues a process-video job with the TD-06 retry policy', async () => {
    await producer.enqueueProcessVideo('video-123');

    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);

    const job = jobs[0];
    expect(job.name).toBe(PROCESS_VIDEO_JOB);
    expect(job.data).toEqual({ videoId: 'video-123' });
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });
});
