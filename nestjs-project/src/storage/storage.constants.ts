export const UPLOAD_PART_URL_TTL_SECONDS = 3600;
export const PLAYBACK_URL_TTL_SECONDS = 3600;

export function videoKey(videoId: string, extension: string): string {
  return `videos/${videoId}/original${extension}`;
}

export function thumbnailKey(videoId: string): string {
  return `thumbnails/${videoId}.jpg`;
}
