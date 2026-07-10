import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import os from 'os';
import { Readable } from 'stream';
import Busboy from 'busboy';

const UPLOAD_DIR = join(process.cwd(), 'public', 'uploads');
const OUTPUT_DIR = join(process.cwd(), 'public', 'output');
const MAX_CORES = Math.min(os.cpus().length, 8);

async function findFfmpeg(): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const exeName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';

  const localPaths = [
    join(process.cwd(), exeName),
    join(process.cwd(), 'bin', exeName),
  ];

  for (const p of localPaths) {
    if (existsSync(p)) return p;
  }

  try {
    const cmd = isWindows ? 'where' : 'which';
    const proc = spawn(cmd, ['ffmpeg'], { shell: true });
    const stdout = await new Promise<string>((resolve, reject) => {
      let data = '';
      proc.stdout.on('data', (chunk) => (data += chunk.toString()));
      proc.on('close', (code) => {
        if (code === 0) resolve(data.trim());
        else reject(new Error('Not found'));
      });
      proc.on('error', reject);
    });

    const path = stdout.split('\n')[0].trim();
    if (path && existsSync(path)) return path;
  } catch {
    // Not found
  }

  return null;
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number = 7200000
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new Error('FFmpeg process timed out'));
    }, timeoutMs);

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve({ code, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function parseMultipart(request: NextRequest): Promise<{
  files: Map<string, Buffer>;
  fields: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>();
    const fields: Record<string, string> = {};

    const contentType = request.headers.get('content-type') || '';
    const nodeStream = Readable.fromWeb(request.body as any);

    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, file, info) => {
      const chunks: Buffer[] = [];
      file.on('data', (data) => chunks.push(data));
      file.on('end', () => {
        files.set(info.filename || 'unknown', Buffer.concat(chunks));
      });
    });

    busboy.on('finish', () => {
      resolve({ files, fields });
    });

    busboy.on('error', reject);
    nodeStream.pipe(busboy);
  });
}

async function getVideoDuration(ffmpegPath: string, inputPath: string): Promise<number> {
  try {
    const { stderr } = await runFfmpeg(
      ffmpegPath,
      ['-i', inputPath, '-f', 'null', '-'],
      30000
    );
    const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      const seconds = parseInt(match[3]);
      const centiseconds = parseInt(match[4]);
      return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
    }
  } catch (error) {
    console.error('[duration] Failed:', (error as Error).message);
  }
  return 0;
}

async function applyFaststart(ffmpegPath: string, inputPath: string): Promise<void> {
  const tempPath = inputPath.replace('.mp4', '_faststart.mp4');
  try {
    const { code } = await runFfmpeg(ffmpegPath, [
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', tempPath,
    ]);

    if (code === 0 && existsSync(tempPath)) {
      const stats = await stat(tempPath);
      if (stats.size > 1024) {
        await unlink(inputPath);
        const { rename } = await import('fs/promises');
        await rename(tempPath, inputPath);
        console.log('[faststart] Applied successfully');
        return;
      }
    }
    
    try { await unlink(tempPath); } catch {}
  } catch (error) {
    console.log('[faststart] Error:', (error as Error).message);
    try { await unlink(tempPath); } catch {}
  }
}

export async function POST(request: NextRequest) {
  try {
    console.log('=== COMPRESS VIDEO REQUEST STARTED ===');

    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) {
      return NextResponse.json(
        { error: 'FFmpeg not found. Please place ffmpeg.exe in the project root folder.' },
        { status: 500 }
      );
    }

    console.log(`Using FFmpeg: ${ffmpegPath}`);
    console.log(`CPU Cores: ${os.cpus().length}, Using: ${MAX_CORES}`);

    if (!existsSync(UPLOAD_DIR)) {
      await mkdir(UPLOAD_DIR, { recursive: true });
    }
    if (!existsSync(OUTPUT_DIR)) {
      await mkdir(OUTPUT_DIR, { recursive: true });
    }

    console.log('Parsing multipart form data...');
    const { files, fields } = await parseMultipart(request);

    console.log(`Files found: ${files.size}`);
    console.log('Fields:', fields);

    const quality = fields.quality || '23';
    const preset = fields.preset || 'medium';
    const resolution = fields.resolution || 'original';

    if (files.size === 0) {
      return NextResponse.json(
        { error: 'No video files provided' },
        { status: 400 }
      );
    }

    const results = [];
    const failed = [];
    let index = 0;

    for (const [originalName, fileBuffer] of files) {
      const inputPath = join(UPLOAD_DIR, `${Date.now()}_${index}_${originalName}`);
      const baseName = originalName.replace(/\.[^.]+$/, '');
      const outputName = `${baseName}_compressed.mp4`;
      const outputPath = join(OUTPUT_DIR, outputName);

      try {
        console.log(`[${index + 1}/${files.size}] Processing: ${originalName} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

        // Сохраняем файл
        await writeFile(inputPath, fileBuffer);

        // Получаем длительность
        const duration = await getVideoDuration(ffmpegPath, inputPath);
        console.log(`  Duration: ${duration}s`);

        // Определяем масштабирование
        let scale = '';
        if (resolution === '1080p') scale = '1920:-2';
        else if (resolution === '720p') scale = '1280:-2';
        else if (resolution === '480p') scale = '854:-2';
        else if (resolution === '360p') scale = '640:-2';

        // Строим аргументы FFmpeg
        const args = [
          '-nostdin',
          '-threads', String(MAX_CORES),
          '-i', inputPath,
          '-c:v', 'libx264',
          '-crf', quality,
          '-preset', preset,
          '-c:a', 'aac',
          '-b:a', '128k',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
        ];

        if (scale) {
          args.push('-vf', `scale=${scale}`);
        }

        args.push('-y', outputPath);

        console.log(`  Running FFmpeg...`);
        const { code, stderr } = await runFfmpeg(ffmpegPath, args);

        if (code !== 0) {
          console.error(`  FFmpeg failed with code ${code}`);
          console.error(`  Last 500 chars: ${stderr.slice(-500)}`);
          throw new Error(`FFmpeg exited with code ${code}`);
        }

        if (!existsSync(outputPath)) {
          throw new Error('Output file was not created');
        }

        const originalStats = await stat(inputPath);
        const compressedStats = await stat(outputPath);
        const originalSize = originalStats.size;
        const compressedSize = compressedStats.size;

        try { await unlink(inputPath); } catch {}

        const compressionRatio =
          originalSize > 0
            ? ((1 - compressedSize / originalSize) * 100).toFixed(1)
            : '0.0';

        results.push({
          name: outputName,
          originalName: originalName,
          originalSize,
          compressedSize,
          compressionRatio,
          duration,
        });

        console.log(`  Done: ${(originalSize / 1024 / 1024).toFixed(2)} MB → ${(compressedSize / 1024 / 1024).toFixed(2)} MB (${compressionRatio}% reduction)`);
      } catch (error: unknown) {
        console.error(`  Failed: ${originalName}`, (error as Error).message);
        
        // Cleanup при ошибке
        try { await unlink(inputPath); } catch {}
        try { await unlink(outputPath); } catch {}
        
        failed.push({
          name: originalName,
          error: (error as Error).message,
        });
      }

      index++;
    }

    console.log(`Complete: ${results.length} success, ${failed.length} failed`);

    return NextResponse.json({
      success: true,
      results,
      failed,
      total: files.size,
      processed: results.length,
    });
  } catch (error: unknown) {
    console.error('Compression error:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}