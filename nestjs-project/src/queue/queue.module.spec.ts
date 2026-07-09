import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VideoQueueProducer } from './video-queue.producer';

describe('QueueModule', () => {
  it('should compile and provide VideoQueueProducer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(module.get(VideoQueueProducer)).toBeInstanceOf(VideoQueueProducer);
    await module.close();
  }, 30000);
});
