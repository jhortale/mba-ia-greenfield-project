import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);

const FFPROBE_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 120_000;
// Thumbnails are small JPEG frames; 32 MiB of stdout headroom is plenty.
const FFMPEG_MAX_BUFFER = 32 * 1024 * 1024;

export interface VideoProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  format: string | null;
  sizeBytes: number;
}

interface FfprobeOutput {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
  format?: {
    duration?: string;
    format_name?: string;
    size?: string;
  };
}

@Injectable()
export class FfmpegService {
  /**
   * Extracts duration and stream metadata. `input` may be a local path or a
   * URL — ffprobe reads HTTP(S) sources natively, so the worker never
   * downloads the (potentially 10GB) file to disk.
   */
  async probe(input: string): Promise<VideoProbeResult> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      { timeout: FFPROBE_TIMEOUT_MS },
    );

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find(
      (s) => s.codec_type === 'video',
    );
    const duration = Number(parsed.format?.duration ?? 0);

    return {
      durationSeconds: Math.round(Number.isFinite(duration) ? duration : 0),
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      codec: videoStream?.codec_name ?? null,
      format: parsed.format?.format_name ?? null,
      sizeBytes: Number(parsed.format?.size ?? 0),
    };
  }

  /**
   * Captures a single frame at `atSecond` as a JPEG buffer (stdout pipe —
   * no temp files).
   */
  async captureFrame(input: string, atSecond: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(atSecond),
        '-i',
        input,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      {
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: FFMPEG_MAX_BUFFER,
        encoding: 'buffer',
      },
    );

    if (stdout.length === 0) {
      throw new Error(`ffmpeg produced an empty frame at second ${atSecond}`);
    }
    return stdout;
  }
}
