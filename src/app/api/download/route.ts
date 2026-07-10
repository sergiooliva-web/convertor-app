import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { createReadStream } from 'fs';

const OUTPUT_DIR = join(process.cwd(), 'public', 'output');

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const filename = searchParams.get('file');

  // Если файл не указан - ошибка
  if (!filename) {
    return NextResponse.json({ error: 'File name not provided' }, { status: 400 });
  }

  // Если запрос на скачивание всех файлов
  if (filename === 'all') {
    return await downloadAllFiles();
  }

  // Скачивание одного файла
  const filePath = join(OUTPUT_DIR, filename);

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found: ' + filename }, { status: 404 });
  }

  try {
    const fileStream = createReadStream(filePath);
    const headers = new Headers();
    headers.set('Content-Type', 'image/webp');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);

    return new NextResponse(fileStream as any, {
      headers,
      status: 200,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}

async function downloadAllFiles() {
  try {
    if (!existsSync(OUTPUT_DIR)) {
      return NextResponse.json({ error: 'Output directory not found' }, { status: 404 });
    }

    const files = readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.webp'));
    
    if (files.length === 0) {
      return NextResponse.json({ error: 'No webp files found' }, { status: 404 });
    }

    // Возвращаем список файлов в JSON для скачивания по одному
    return NextResponse.json({
      files: files,
      count: files.length,
      message: 'Download each file individually using /api/download?file=filename.webp'
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}