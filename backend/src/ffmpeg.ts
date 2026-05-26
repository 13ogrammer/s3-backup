// ffmpeg wrapper for video preview transcoding.
//
// Binary resolution order:
//   1. FFMPEG_PATH env var (local dev or custom Lambda layer mount)
//   2. /var/task/bin/ffmpeg — vendored static ARM64 binary in the Lambda artifact
//   3. Throws a clear error so the Lambda startup log is actionable.
//
// Output spec (locked by Architect):
//   - Scale to max 1280 px wide, preserve aspect ratio, height divisible by 2
//   - libx264 preset=veryfast crf=28
//   - AAC audio 96 kbps
//   - -movflags +faststart (MOOV atom at front for streaming)

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';

function resolveBinary(): string {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath) return envPath;
  return '/var/task/bin/ffmpeg';
}

async function assertBinaryExecutable(bin: string): Promise<void> {
  try {
    await access(bin, constants.X_OK);
  } catch {
    throw new Error(
      `ffmpeg binary not found or not executable at: ${bin}. ` +
      `Set FFMPEG_PATH env var or run backend/scripts/fetch-ffmpeg.sh before sam build.`,
    );
  }
}

export async function transcodeVideoToPreview(
  inputPath: string,
  outputPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const bin = resolveBinary();
  await assertBinaryExecutable(bin);

  const args = [
    '-y',                              // overwrite output without asking
    '-i', inputPath,
    '-vf', "scale='min(1280,iw)':-2",  // scale to max 1280 px wide; -2 keeps height even
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    outputPath,
  ];

  log(`ffmpeg: ${bin} ${args.join(' ')}`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d: Buffer) => log(`ffmpeg stdout: ${d.toString().trim()}`));
    proc.stderr.on('data', (d: Buffer) => log(`ffmpeg stderr: ${d.toString().trim()}`));

    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}
