import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

describe('Worker providers', () => {
  it('compile FfmpegService and VideoProcessor with mocked infrastructure', async () => {
    const module = await Test.createTestingModule({
      providers: [
        FfmpegService,
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: {} },
      ],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);
  });
});
