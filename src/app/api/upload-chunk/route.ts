import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, unlink, stat, readdir, readFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import Busboy from 'busboy';
import os from 'os';

const UPLOAD_DIR = join(process.cwd(), 'public', 'uploads');
const OUTPUT_DIR = join(process.cwd(), 'public', 'output');
const CHUNK_DIR = join(process.cwd(), 'public', 'chunks');
const MAX_CORES = Math.min(os.cpus().length, 8);
const CLEANUP_AGE_MS = 60 * 60 * 1000;

// Хранилище статусов задач (в памяти)
// В продакшене лучше использовать Redis или БД
export const taskStatuses = new Map<string, {
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  outputName?: string;
  originalName?: string;
  originalSize?: number;
  compressedSize?: number;
  compressionRatio?: string;
  duration?: number;
  error?: string;
  createdAt: number;
}>();

const activeUploads = new Set<string>();
let lastCleanupTime = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

async function cleanupOldFiles(currentUploadId?: string) {
  const now = Date.now();
  if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) return;
  lastCleanupTime = now;

  try {
    for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
      if (!existsSync(dir)) continue;
      const files = await readdir(dir);
      for (const file of files) {
        const filePath = join(dir, file);
        const stats = await stat(filePath);
        if (now - stats.mtimeMs > CLEANUP_AGE_MS) {
          await unlink(filePath);
          console.log(`[cleanup] Removed old file: ${file}`);
        }
      }
    }
    
    if (existsSync(CHUNK_DIR)) {
      const dirs = await readdir(CHUNK_DIR);
      for (const dir of dirs) {
        if (currentUploadId && dir === currentUploadId) continue;
        if (activeUploads.has(dir)) continue;
        
        const dirPath = join(CHUNK_DIR, dir);
        const stats = await stat(dirPath);
        if (now - stats.mtimeMs > CLEANUP_AGE_MS) {
          const chunkFiles = await readdir(dirPath);
          for (const chunk of chunkFiles) {
            try { await unlink(join(dirPath, chunk)); } catch {}
          }
          try { await unlink(dirPath); } catch {}
          console.log(`[cleanup] Removed old chunks: ${dir}`);
        }
      }
    }

    // Очистка старых задач из памяти (старше 1 часа)
    for (const [taskId, task] of taskStatuses) {
      if (now - task.createdAt > CLEANUP_AGE_MS) {
        taskStatuses.delete(taskId);
      }
    }
  } catch (error) {
    console.warn('[cleanup] Warning:', error);
  }
}

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

function runFfmpegWithProgress(
  ffmpegPath: string,
  args: string[],
  totalDuration: number,
  taskId: string,
  timeoutMs: number = 7200000
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let timedOut = false;
    let lastProgressLog = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new Error('FFmpeg process timed out'));
    }, timeoutMs);

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;

      const timeMatch = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (timeMatch && totalDuration > 0) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseInt(timeMatch[3]);
        const currentTime = hours * 3600 + minutes * 60 + seconds;
        const progress = Math.min((currentTime / totalDuration) * 100, 100);

        // Обновляем статус задачи
        const task = taskStatuses.get(taskId);
        if (task) {
          task.progress = progress;
        }

        const now = Date.now();
        if (now - lastProgressLog > 5000) {
          console.log(`[ffmpeg][${taskId}] Progress: ${progress.toFixed(1)}% (${currentTime}s / ${totalDuration}s)`);
          lastProgressLog = now;
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      console.log(`[ffmpeg][${taskId}] Process completed with code ${code}`);
      resolve({ code, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function parseMultipart(request: NextRequest): Promise<{
  fields: Record<string, string>;
  fileChunk: Buffer | null;
  filename: string;
}> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let fileChunk: Buffer | null = null;
    let filename = 'video.mp4';

    const contentType = request.headers.get('content-type') || '';
    const nodeStream = Readable.fromWeb(request.body as any);

    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: 1024 * 1024 * 1024 },
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, file, info) => {
      filename = info.filename || 'video.mp4';
      const chunks: Buffer[] = [];
      file.on('data', (data) => chunks.push(data));
      file.on('end', () => {
        fileChunk = Buffer.concat(chunks);
      });
    });

    busboy.on('finish', () => {
      resolve({ fields, fileChunk, filename });
    });

    busboy.on('error', reject);
    nodeStream.pipe(busboy);
  });
}

async function assembleFile(uploadId: string, filename: string): Promise<string> {
  const chunkDir = join(CHUNK_DIR, uploadId);
  const files = await readdir(chunkDir);
  const chunkFiles = files.filter((f) => f.endsWith('.part')).sort();

  if (chunkFiles.length === 0) {
    throw new Error('No chunks found');
  }

  const outputPath = join(UPLOAD_DIR, filename);

  for (const chunkFile of chunkFiles) {
    const chunkPath = join(chunkDir, chunkFile);
    const chunkData = await readFile(chunkPath);
    await appendFile(outputPath, chunkData);
  }

  for (const chunkFile of chunkFiles) {
    try { await unlink(join(chunkDir, chunkFile)); } catch {}
  }
  try { await unlink(chunkDir); } catch {}

  return outputPath;
}

async function getVideoDuration(ffmpegPath: string, inputPath: string): Promise<number> {
  try {
    const proc = spawn(ffmpegPath, ['-i', inputPath, '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    
    return new Promise((resolve) => {
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', () => {
        const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (match) {
          const hours = parseInt(match[1]);
          const minutes = parseInt(match[2]);
          const seconds = parseInt(match[3]);
          const centiseconds = parseInt(match[4]);
          resolve(hours * 3600 + minutes * 60 + seconds + centiseconds / 100);
        } else {
          resolve(0);
        }
      });

      proc.on('error', () => resolve(0));
    });
  } catch (error) {
    console.error('[duration] Failed:', (error as Error).message);
  }
  return 0;
}

// Фоновая обработка сжатия — НЕ блокирует HTTP ответ
async function processCompressionInBackground(
  taskId: string,
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  quality: string,
  preset: string,
  resolution: string,
  filename: string
) {
  try {
    const duration = await getVideoDuration(ffmpegPath, inputPath);
    console.log(`[compress][${taskId}] Original duration: ${duration}s`);

    const originalStats = await stat(inputPath);
    const originalSize = originalStats.size;
    console.log(`[compress][${taskId}] Original size: ${(originalSize / 1024 / 1024).toFixed(2)} MB`);

    const DURATION_TOLERANCE = 0.80;
    const MIN_COMPRESSION_RATIO = 0.05;

    let scale = '';
    if (resolution === '1080p') scale = '1920:-2';
    else if (resolution === '720p') scale = '1280:-2';
    else if (resolution === '480p') scale = '854:-2';
    else if (resolution === '360p') scale = '640:-2';

    const strategies = [
      {
        name: 'Real compression (libx264)',
        args: [
          '-nostdin', '-threads', String(MAX_CORES),
          '-i', inputPath,
          '-c:v', 'libx264', '-crf', quality, '-preset', preset,
          '-c:a', 'aac', '-b:a', '128k',
          ...(scale ? ['-vf', `scale=${scale}`] : []),
          '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          '-y', outputPath,
        ],
        requireCompression: true,
      },
      {
        name: 'HEVC compression',
        args: [
          '-nostdin', '-i', inputPath,
          '-c:v', 'libx265', '-crf', String(parseInt(quality) + 5), '-preset', preset,
          '-c:a', 'aac', '-b:a', '128k',
          ...(scale ? ['-vf', `scale=${scale}`] : []),
          '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          '-y', outputPath,
        ],
        requireCompression: true,
      },
      {
        name: 'Stream copy',
        args: [
          '-nostdin', '-i', inputPath,
          '-c', 'copy', '-movflags', '+faststart',
          '-y', outputPath,
        ],
        requireCompression: false,
      },
    ];

    for (const strategy of strategies) {
      console.log(`[compress][${taskId}] Trying: ${strategy.name}`);

      try { await unlink(outputPath); } catch {}

      const { code, stderr } = await runFfmpegWithProgress(
        ffmpegPath, strategy.args, duration, taskId
      );

      if (!existsSync(outputPath) || code !== 0) {
        console.log(`[compress][${taskId}] ${strategy.name} failed`);
        continue;
      }

      const stats = await stat(outputPath);
      if (stats.size < 1024) {
        try { await unlink(outputPath); } catch {}
        continue;
      }

      const outputDuration = await getVideoDuration(ffmpegPath, outputPath);
      const durationRatio = duration > 0 ? outputDuration / duration : 1;

      if (durationRatio < DURATION_TOLERANCE) {
        try { await unlink(outputPath); } catch {}
        continue;
      }

      const compressionRatio = (originalSize - stats.size) / originalSize;

      if (strategy.requireCompression && compressionRatio < MIN_COMPRESSION_RATIO) {
        try { await unlink(outputPath); } catch {}
        continue;
      }

      console.log(`[compress][${taskId}] ${strategy.name} succeeded!`);

      try { await unlink(inputPath); } catch {}

      const outputName = `${filename.replace(/\.[^.]+$/, '')}_compressed.mp4`;

      // Обновляем статус задачи
      const task = taskStatuses.get(taskId);
      if (task) {
        task.status = 'completed';
        task.progress = 100;
        task.outputName = outputName;
        task.originalName = filename;
        task.originalSize = originalSize;
        task.compressedSize = stats.size;
        task.compressionRatio = ((1 - stats.size / originalSize) * 100).toFixed(1);
        task.duration = duration;
      }

      console.log(`[compress][${taskId}] Complete!`);
      return;
    }

    throw new Error('All compression strategies failed');
  } catch (error) {
    console.error(`[compress][${taskId}] Error:`, error);
    const task = taskStatuses.get(taskId);
    if (task) {
      task.status = 'failed';
      task.error = (error as Error).message;
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
    }

    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) {
      return NextResponse.json({ error: 'FFmpeg not found' }, { status: 500 });
    }

    await Promise.all([
      !existsSync(UPLOAD_DIR) && mkdir(UPLOAD_DIR, { recursive: true }),
      !existsSync(CHUNK_DIR) && mkdir(CHUNK_DIR, { recursive: true }),
      !existsSync(OUTPUT_DIR) && mkdir(OUTPUT_DIR, { recursive: true }),
    ]);

    const { fields, fileChunk, filename } = await parseMultipart(request);

    const uploadId = fields.uploadId || '';
    const chunkIndex = parseInt(fields.chunkIndex || '0', 10);
    const totalChunks = parseInt(fields.totalChunks || '0', 10);
    const quality = fields.quality || '23';
    const preset = fields.preset || 'medium';
    const resolution = fields.resolution || 'original';

    if (uploadId) {
      activeUploads.add(uploadId);
    }

    cleanupOldFiles(uploadId).catch(console.warn);

    if (!uploadId || !fileChunk || fileChunk.length === 0) {
      return NextResponse.json({ error: 'Missing uploadId or file chunk' }, { status: 400 });
    }

    if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || totalChunks <= 0) {
      return NextResponse.json({ error: 'Invalid chunkIndex or totalChunks' }, { status: 400 });
    }

    const chunkDir = join(CHUNK_DIR, uploadId);
    if (!existsSync(chunkDir)) {
      await mkdir(chunkDir, { recursive: true });
    }

    const chunkPath = join(chunkDir, `chunk_${String(chunkIndex).padStart(6, '0')}.part`);
    await writeFile(chunkPath, fileChunk);
    console.log(`[upload] Chunk ${chunkIndex + 1}/${totalChunks} saved`);

    // Если последний чанк — запускаем сжатие В ФОНЕ
    if (chunkIndex === totalChunks - 1) {
      console.log('[upload] All chunks received. Starting background compression...');

      const inputPath = await assembleFile(uploadId, filename);
      activeUploads.delete(uploadId);

      const taskId = uploadId; // Используем uploadId как taskId
      const baseName = filename.replace(/\.[^.]+$/, '');
      const outputName = `${baseName}_compressed.mp4`;
      const outputPath = join(OUTPUT_DIR, outputName);

      // Создаём запись о задаче
      taskStatuses.set(taskId, {
        status: 'processing',
        progress: 0,
        originalName: filename,
        createdAt: Date.now(),
      });

      // ЗАПУСКАЕМ В ФОНЕ — не ждём завершения!
      processCompressionInBackground(
        taskId, ffmpegPath, inputPath, outputPath,
        quality, preset, resolution, filename
      ).catch(err => {
        console.error(`[background][${taskId}] Fatal error:`, err);
      });

      // СРАЗУ возвращаем ответ клиенту
      return NextResponse.json({
        success: true,
        taskId: taskId,
        message: 'Compression started in background',
      });
    }

    return NextResponse.json({
      success: true,
      chunkIndex,
      totalChunks,
      uploadId,
      message: `Chunk ${chunkIndex + 1}/${totalChunks} uploaded`,
    });
  } catch (error: unknown) {
    console.error('[upload] Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}