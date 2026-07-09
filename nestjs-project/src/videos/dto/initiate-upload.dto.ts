import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';

export class InitiateUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @IsString()
  @Matches(/^video\//, { message: 'contentType must be a video/* MIME type' })
  @MaxLength(100)
  contentType: string;

  @IsInt()
  @IsPositive()
  @Max(MAX_VIDEO_SIZE_BYTES, {
    message: 'sizeBytes must not exceed the 10GB limit',
  })
  sizeBytes: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;
}
