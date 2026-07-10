import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

const UPLOAD_DIR = join(process.cwd(), 'public', 'uploads');
const OUTPUT_DIR = join(process.cwd(), 'public', 'output');

async function checkTools(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await execAsync('where cwebp');
      await execAsync('where gif2webp');
    } else {
      await execAsync('which cwebp');
      await execAsync('which gif2webp');
    }
    return true;
  } catch {
    return false;
  }
}

async function convertFile(
  inputPath: string,
  outputPath: string,
  quality: number = 85
): Promise<{ success: boolean; error?: string }> {
  const ext = inputPath.split('.').pop()?.toLowerCase() || '';
  
  const tool = ext === 'gif' ? 'gif2webp' : 'cwebp';
  
  let cmd: string;
  if (ext === 'gif') {
    cmd = `${tool} -q ${quality} "${inputPath}" -o "${outputPath}"`;
  } else {
    cmd = `${tool} -q ${quality} -mt "${inputPath}" -o "${outputPath}"`;
  }

  try {
    const { stderr } = await execAsync(cmd);
    if (stderr) {
      console.warn('Warning:', stderr);
    }
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message };
  }
}

export async function POST(request: NextRequest) {
  try {
    const toolsOk = await checkTools();
    if (!toolsOk) {
      return NextResponse.json(
        {
          error:
            'cwebp/gif2webp tools not found. Install: npm install cwebp-bin gif2webp-bin',
        },
        { status: 500 }
      );
    }

    if (!existsSync(UPLOAD_DIR)) {
      await mkdir(UPLOAD_DIR, { recursive: true });
    }
    if (!existsSync(OUTPUT_DIR)) {
      await mkdir(OUTPUT_DIR, { recursive: true });
    }

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const quality = Number(formData.get('quality') || 85);

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files selected' }, { status: 400 });
    }

    const success: string[] = [];
    const failed: string[] = [];

    for (const file of files) {
      const originalName = file.name;
      const baseName = originalName.replace(/\.[^.]+$/, '');
      const webpName = `${baseName}.webp`;

      const inputPath = join(UPLOAD_DIR, originalName);
      const outputPath = join(OUTPUT_DIR, webpName);

      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      await writeFile(inputPath, buffer);

      const result = await convertFile(inputPath, outputPath, quality);

      if (result.success) {
        success.push(webpName);
      } else {
        failed.push(`${originalName} (${result.error})`);
      }

      try {
        await unlink(inputPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    return NextResponse.json({
      success,
      failed,
      outputPath: OUTPUT_DIR,
      total: files.length,
    });
  } catch (error: unknown) {
    console.error('Conversion error:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}