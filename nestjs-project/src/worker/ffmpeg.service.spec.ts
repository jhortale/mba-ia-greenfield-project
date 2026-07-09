import { FfmpegService } from './ffmpeg.service';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

import { execFile } from 'node:child_process';

const execFileMock = execFile as unknown as jest.Mock;

function mockExecResult(result: { stdout: string | Buffer; stderr?: string }) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null, res: unknown) => void,
    ) => {
      callback(null, { stderr: '', ...result });
      return {} as any;
    },
  );
}

function mockExecError(error: Error) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null, res: unknown) => void,
    ) => {
      callback(error, { stdout: '', stderr: 'boom' });
      return {} as any;
    },
  );
}

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(() => {
    service = new FfmpegService();
    execFileMock.mockReset();
  });

  describe('probe', () => {
    const ffprobeJson = JSON.stringify({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      ],
      format: {
        duration: '12.48',
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        size: '1048576',
      },
    });

    it('builds the ffprobe command and parses the metadata', async () => {
      mockExecResult({ stdout: ffprobeJson });

      const result = await service.probe('http://minio:9000/signed');

      const [cmd, args] = execFileMock.mock.calls[0];
      expect(cmd).toBe('ffprobe');
      expect(args).toEqual(
        expect.arrayContaining([
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          'http://minio:9000/signed',
        ]),
      );
      expect(result).toEqual({
        durationSeconds: 12,
        width: 1920,
        height: 1080,
        codec: 'h264',
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        sizeBytes: 1048576,
      });
    });

    it('handles sources with no video stream', async () => {
      mockExecResult({
        stdout: JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: 'aac' }],
          format: { duration: '3.2', format_name: 'wav', size: '10' },
        }),
      });

      const result = await service.probe('file.wav');

      expect(result.width).toBeNull();
      expect(result.codec).toBeNull();
      expect(result.durationSeconds).toBe(3);
    });

    it('propagates ffprobe failures', async () => {
      mockExecError(new Error('Invalid data found when processing input'));

      await expect(service.probe('bad-input')).rejects.toThrow(
        'Invalid data found',
      );
    });
  });

  describe('captureFrame', () => {
    it('builds the ffmpeg command and returns the JPEG buffer', async () => {
      mockExecResult({ stdout: Buffer.from([0xff, 0xd8, 0xff]) });

      const frame = await service.captureFrame('http://src', 1);

      const [cmd, args] = execFileMock.mock.calls[0];
      expect(cmd).toBe('ffmpeg');
      expect(args).toEqual(
        expect.arrayContaining(['-ss', '1', '-i', 'http://src', '-frames:v', '1']),
      );
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect(frame.length).toBe(3);
    });

    it('throws when ffmpeg produces an empty frame', async () => {
      mockExecResult({ stdout: Buffer.alloc(0) });

      await expect(service.captureFrame('http://src', 1)).rejects.toThrow(
        'empty frame',
      );
    });
  });
});
