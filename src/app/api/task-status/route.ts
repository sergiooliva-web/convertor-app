import { NextRequest, NextResponse } from 'next/server';
import { taskStatuses } from '../upload-chunk/route';

export async function GET(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get('taskId');
  
  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  const task = taskStatuses.get(taskId);
  
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  return NextResponse.json({
    taskId,
    status: task.status,
    progress: task.progress,
    outputName: task.outputName,
    originalName: task.originalName,
    originalSize: task.originalSize,
    compressedSize: task.compressedSize,
    compressionRatio: task.compressionRatio,
    duration: task.duration,
    error: task.error,
    download: task.outputName ? `/api/download?file=${encodeURIComponent(task.outputName)}` : null,
  });
}