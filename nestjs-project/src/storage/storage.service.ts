import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  PLAYBACK_URL_TTL_SECONDS,
  UPLOAD_PART_URL_TTL_SECONDS,
} from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  downloadFilename?: string;
  /**
   * Sign against the internal Docker endpoint instead of the public one.
   * Used by the worker, whose ffmpeg reads run inside the Compose network.
   */
  internal?: boolean;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const clientOptions = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    };
    this.client = new S3Client({ ...clientOptions, endpoint: config.endpoint });
    this.publicClient = new S3Client({
      ...clientOptions,
      endpoint: config.publicEndpoint,
    });
    this.bucket = config.bucket;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
      } catch (err) {
        // Concurrent creation (another container bootstrapping) is fine.
        if (!isAlreadyOwnedError(err)) throw err;
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return result.UploadId!;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: UPLOAD_PART_URL_TTL_SECONDS },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { sizeBytes: result.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async presignGetObject(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    const client = options.internal ? this.client : this.publicClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.downloadFilename && {
          ResponseContentDisposition: `attachment; filename="${options.downloadFilename}"`,
        }),
      }),
      { expiresIn: PLAYBACK_URL_TTL_SECONDS },
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

function isAlreadyOwnedError(err: unknown): boolean {
  const e = err as { name?: string };
  return (
    e.name === 'BucketAlreadyOwnedByYou' || e.name === 'BucketAlreadyExists'
  );
}
