export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
} as const;

export interface ProcessVideoJobData {
  videoId: string;
}
