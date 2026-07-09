import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Graceful shutdown lets in-flight FFmpeg jobs finish before exit.
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Video worker started — consuming queue');
}

void bootstrap();
