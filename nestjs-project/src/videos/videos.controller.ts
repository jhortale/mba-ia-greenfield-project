import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { VideosService } from './videos.service';
import type { PresignedPart } from './videos.service';
import type { Video, VideoMetadata } from './entities/video.entity';

interface VideoSummary {
  id: string;
  urlId: string;
  title: string;
  status: string;
}

function toVideoSummary(video: Video): VideoSummary {
  return {
    id: video.id,
    urlId: video.url_id,
    title: video.title,
    status: video.status,
  };
}

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft under the caller channel and returns presigned multipart URLs for uploading directly to object storage (up to 10GB).',
  })
  @ApiResponse({ status: 201, description: 'Draft created, part URLs issued' })
  @ApiResponse({
    status: 400,
    description: 'Invalid body (including size above the 10GB limit)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<{
    video: VideoSummary;
    upload: { partSizeBytes: number; partCount: number; parts: PresignedPart[] };
  }> {
    const result = await this.videosService.initiateUpload(user.sub, dto);
    return { video: toVideoSummary(result.video), upload: result.upload };
  }

  @Post(':videoId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Re-issue presigned part URLs',
    description:
      'Issues fresh presigned URLs for the requested part numbers, supporting resume after connection failures or URL expiry.',
  })
  @ApiResponse({ status: 200, description: 'Part URLs issued' })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No upload in progress for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async requestPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<{ parts: PresignedPart[] }> {
    const parts = await this.videosService.requestPartUrls(
      user.sub,
      videoId,
      dto,
    );
    return { parts };
  }

  @Post(':videoId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload in storage, verifies the stored object, flips the video to processing and enqueues the processing job.',
  })
  @ApiResponse({ status: 200, description: 'Upload completed, processing enqueued' })
  @ApiResponse({
    status: 400,
    description: 'Upload incomplete or size mismatch',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No upload in progress for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoSummary> {
    const video = await this.videosService.completeUpload(
      user.sub,
      videoId,
      dto,
    );
    return toVideoSummary(video);
  }

  @Get(':urlId')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video details by public URL id',
    description:
      'Returns the video details, including duration, metadata and a presigned thumbnail URL once processing has finished.',
  })
  @ApiResponse({ status: 200, description: 'Video details' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getByUrlId(@Param('urlId') urlId: string): Promise<{
    id: string;
    urlId: string;
    title: string;
    status: string;
    durationSeconds: number | null;
    metadata: VideoMetadata | null;
    thumbnailUrl: string | null;
    createdAt: Date;
    channel: { id: string; name: string; nickname: string };
  }> {
    const video = await this.videosService.findByUrlId(urlId);
    const thumbnailUrl = await this.videosService.getThumbnailUrl(video);
    return {
      id: video.id,
      urlId: video.url_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
      createdAt: video.created_at,
      channel: {
        id: video.channel.id,
        name: video.channel.name,
        nickname: video.channel.nickname,
      },
    };
  }

  @Get(':urlId/stream-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a short-lived presigned URL served directly by object storage with native Range/206 support — playback starts without downloading the full file.',
  })
  @ApiResponse({ status: 200, description: 'Presigned streaming URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @Param('urlId') urlId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.videosService.getStreamUrl(urlId);
  }

  @Get(':urlId/download-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a short-lived presigned URL with attachment content disposition for downloading the original file.',
  })
  @ApiResponse({ status: 200, description: 'Presigned download URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @Param('urlId') urlId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.videosService.getDownloadUrl(urlId);
  }
}
