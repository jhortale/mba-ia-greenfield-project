import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// Tests run inside the nestjs-api container: the "public" endpoint (used by
// browsers on the host) is unreachable here, so presigned URLs are signed
// against the in-network MinIO hostname for this suite.
process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

// Runs against the real MinIO service from Docker Compose (no storage mocks).
describe('StorageService (integration)', () => {
  let storage: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storage = module.get(StorageService);
    await storage.ensureBucket();
  });

  it('ensureBucket is idempotent', async () => {
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('putObject / headObject / presigned GET / deleteObject round-trip', async () => {
    const key = `videos/it-roundtrip/original.bin`;
    const body = Buffer.from('streamtube-integration-roundtrip');

    await storage.putObject(key, body, 'application/octet-stream');

    const head = await storage.headObject(key);
    expect(head).not.toBeNull();
    expect(head!.sizeBytes).toBe(body.length);

    const url = await storage.presignGetObject(key);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);

    await storage.deleteObject(key);
    expect(await storage.headObject(key)).toBeNull();
  });

  it('presigned GET honors Range requests with 206 Partial Content', async () => {
    const key = `videos/it-range/original.bin`;
    const body = Buffer.from('0123456789abcdef');
    await storage.putObject(key, body, 'application/octet-stream');

    const url = await storage.presignGetObject(key);
    const response = await fetch(url, { headers: { Range: 'bytes=4-9' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 4-9/16');
    expect(await response.text()).toBe('456789');

    await storage.deleteObject(key);
  });

  it('presigned GET with downloadFilename sets attachment disposition', async () => {
    const key = `videos/it-download/original.bin`;
    await storage.putObject(key, Buffer.from('x'), 'application/octet-stream');

    const url = await storage.presignGetObject(key, {
      downloadFilename: 'my movie.mp4',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="my movie.mp4"',
    );

    await storage.deleteObject(key);
  });

  it('multipart lifecycle: create → presigned part PUT → complete → verify', async () => {
    const key = `videos/it-multipart/original.bin`;
    // MinIO enforces the 5 MiB minimum only for non-last parts; a single
    // part can be any size.
    const part = Buffer.alloc(1024, 7);

    const uploadId = await storage.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(uploadId).toBeTruthy();

    const partUrl = await storage.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, { method: 'PUT', body: part });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag! },
    ]);

    const head = await storage.headObject(key);
    expect(head).not.toBeNull();
    expect(head!.sizeBytes).toBe(part.length);

    await storage.deleteObject(key);
  });

  it('abortMultipartUpload discards a pending upload', async () => {
    const key = `videos/it-abort/original.bin`;
    const uploadId = await storage.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await storage.abortMultipartUpload(key, uploadId);

    // After abort, completing must fail and no object exists.
    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"whatever"' },
      ]),
    ).rejects.toBeDefined();
    expect(await storage.headObject(key)).toBeNull();
  });

  it('headObject returns null for a missing key', async () => {
    expect(await storage.headObject('videos/does-not-exist/x.bin')).toBeNull();
  });
});
