import { ArrayNotEmpty, IsArray, IsInt, Min } from 'class-validator';

export class RequestPartUrlsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
