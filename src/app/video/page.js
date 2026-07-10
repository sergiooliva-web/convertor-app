'use client';

import { useState, useRef } from 'react';

export default function VideoPage() {
  const [files, setFiles] = useState([]);
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [speed, setSpeed] = useState('N/A');
  const [eta, setEta] = useState('N/A');
  const [results, setResults] = useState([]);
  const [failed, setFailed] = useState([]);
  const [quality, setQuality] = useState('23');
  const [preset, setPreset] = useState('medium');
  const [resolution, setResolution] = useState('original');
  const fileInputRef = useRef(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const startTimeRef = useRef(null);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);

  const handleFileSelect = (e) => {
    const selected = Array.from(e.target.files || []);
    const valid = selected.filter(f => f.type.startsWith('video/'));
    
    if (valid.length === 0) {
      alert('Please select video files');
      return;
    }

    setFiles(prev => [...prev, ...valid.map(f => ({
      name: f.name,
      size: f.size,
      type: f.type,
      file: f
    }))]);
    
    setResults([]);
    setFailed([]);
    setProgress(0);
    setProgressText('');
    setSpeed('N/A');
    setEta('N/A');
  };

  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setFiles([]);
    setResults([]);
    setFailed([]);
    setProgress(0);
    setProgressText('');
    setSpeed('N/A');
    setEta('N/A');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Опрос статуса задачи сжатия
  const pollTaskStatus = async (taskId) => {
    const POLL_INTERVAL = 2000;
    const MAX_ATTEMPTS = 1800;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

      const response = await fetch(`/api/task-status?taskId=${taskId}`);
      
      if (!response.ok) {
        throw new Error(`Status check failed: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.status === 'completed') {
        return data;
      }

      if (data.status === 'failed') {
        throw new Error(data.error || 'Compression failed');
      }

      if (data.status === 'processing') {
        const compressionProgress = 50 + (data.progress / 2);
        setProgress(compressionProgress);
        setProgressText(`Compressing: ${data.progress.toFixed(1)}%`);
      }
    }

    throw new Error('Task timeout');
  };

  // Загрузка файла по частям с опросом статуса
  const uploadFileInChunks = async (file, quality, preset, resolution, fileIndex, totalFiles) => {
    const CHUNK_SIZE = 10 * 1024 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(`Uploading ${file.name} in ${totalChunks} chunks`);

    let taskId = null;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const formData = new FormData();
      formData.append('file', chunk, file.name);
      formData.append('chunkIndex', i.toString());
      formData.append('totalChunks', totalChunks.toString());
      formData.append('uploadId', uploadId);
      formData.append('filename', file.name);
      formData.append('quality', quality);
      formData.append('preset', preset);
      formData.append('resolution', resolution);

      const xhr = new XMLHttpRequest();
      const uploadPromise = new Promise((resolve, reject) => {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const totalPercent = Math.round(((i + (event.loaded / event.total)) / totalChunks) * 100);
            const fileProgress = Math.round(((fileIndex) / totalFiles) * 50) + Math.round((totalPercent / totalFiles) * 50);
            setProgress(Math.min(fileProgress, 49));
            setProgressText(`Uploading ${file.name}: ${totalPercent}% (${i + 1}/${totalChunks})`);
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status === 200) {
            try {
              const data = JSON.parse(xhr.responseText);
              resolve(data);
            } catch {
              reject(new Error('Invalid response'));
            }
          } else {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.addEventListener('timeout', () => reject(new Error('Upload timeout')));
        
        xhr.open('POST', '/api/upload-chunk');
        xhr.timeout = 60000;
        xhr.send(formData);
      });

      const data = await uploadPromise;
      
      if (data.taskId) {
        taskId = data.taskId;
        console.log('Compression started, taskId:', taskId);
      }

      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      if (elapsed > 0 && i > 0) {
        const uploadedMB = ((i + 1) * CHUNK_SIZE) / (1024 * 1024);
        const speedMBps = uploadedMB / elapsed;
        setSpeed(`${speedMBps.toFixed(1)} MB/s`);

        const remainingBytes = (totalChunks - i - 1) * CHUNK_SIZE;
        const remainingSeconds = remainingBytes / (1024 * 1024) / speedMBps;
        if (remainingSeconds > 0 && isFinite(remainingSeconds)) {
          const mins = Math.floor(remainingSeconds / 60);
          const secs = Math.floor(remainingSeconds % 60);
          setEta(`${mins}m ${secs}s`);
        } else {
          setEta('< 1m');
        }
      }
    }

    if (!taskId) {
      throw new Error('No taskId received from server');
    }

    setProgressText(`Waiting for compression to start...`);
    const result = await pollTaskStatus(taskId);
    
    return result;
  };

  const handleCompress = async () => {
    if (files.length === 0) {
      alert('Please select video files');
      return;
    }

    setCompressing(true);
    setProgress(0);
    setProgressText('Starting upload...');
    setSpeed('N/A');
    setEta('N/A');
    setResults([]);
    setFailed([]);
    startTimeRef.current = Date.now();
    setCurrentFileIndex(0);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setCurrentFileIndex(i);
        setProgressText(`Processing ${file.name} (${i + 1}/${files.length})...`);
        
        const result = await uploadFileInChunks(
          file.file,
          quality,
          preset,
          resolution,
          i,
          files.length
        );

        if (result && result.status === 'completed') {
          setResults(prev => [...prev, {
            name: result.outputName,
            originalName: result.originalName || file.name,
            originalSize: result.originalSize,
            compressedSize: result.compressedSize,
            compressionRatio: result.compressionRatio,
            download: result.download
          }]);
        } else if (result && result.error) {
          setFailed(prev => [...prev, {
            name: file.name,
            error: result.error
          }]);
        }
      }

      setProgress(100);
      setProgressText('Compression complete!');
      setSpeed('Done');
      setEta('Done');

    } catch (error) {
      alert('Error: ' + error.message);
    } finally {
      setCompressing(false);
    }
  };

  const handleDownload = (filename) => {
    window.open(`/api/download?file=${encodeURIComponent(filename)}`, '_blank');
  };

  const handleDownloadAll = async () => {
    if (results.length === 0) {
      alert('No files to download');
      return;
    }

    setDownloadingAll(true);

    try {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const link = document.createElement('a');
        link.href = `/api/download?file=${encodeURIComponent(result.name)}`;
        link.download = result.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      alert('Download error: ' + error.message);
    } finally {
      setDownloadingAll(false);
    }
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  return (
    <main className="min-h-screen bg-[#2d3436] text-[#f9f9f9] p-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <h1 className="text-4xl text-[#f9f9f9]">Video Compressor</h1>
          <p className="text-[#f9f9f9] mt-2">Compress multiple videos without losing quality</p>
          <div className="mt-2">
            <a href="/" className="text-lg text-[#75BDF0] hover:text-[#A3D3F5] transition-colors inline-flex items-center gap-1">
              ← Back to Image Converter
            </a>
          </div>
        </div>

        <div className="bg-white/5 rounded-xl p-4 mb-6 border border-white/10">
          <div className="flex items-start gap-3">
            <img src="/info.png" alt="Info" className="w-6 h-6 mt-1" />
            <div>
              <p className="text-lg text-[#f9f9f9]">How to compress multiple videos:</p>
              <ol className="text-sm text-[#CCCCCC] mt-1 space-y-1 list-decimal list-inside">
                <li>Upload multiple video files (MP4, MOV, AVI, MKV, WebM)</li>
                <li>Adjust settings for all videos</li>
                <li>Click <span className="text-[#f9f9f9]">Compress All</span> and wait</li>
                <li>Download individual files or all at once</li>
              </ol>
            </div>
          </div>
        </div>

        <div className="bg-white/5 backdrop-blur-sm rounded-2xl p-8 border border-white/10 mb-6">
          <div
            className="border-2 border-dashed border-[#f9f9f9] rounded-2xl p-10 text-center cursor-pointer hover:border-[#FF9C33] transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="text-5xl mb-4 text-[#f9f9f9]">📁</div>
            <p className="text-lg font-medium">Click to select multiple videos</p>
            <p className="text-sm text-[#f9f9f9] mt-1">Supports MP4, AVI, MOV, MKV, WebM and more</p>
            {files.length > 0 && (
              <p className="text-[#f9f9f9] mt-3 font-medium">
                Selected: {files.length} file{files.length > 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>

        {files.length > 0 && (
          <div className="bg-white/5 rounded-xl p-4 mb-6 border border-white/10">
            <div className="flex justify-between items-center mb-3">
              <span className="font-medium text-[#f9f9f9]">
                Selected {files.length} file{files.length > 1 ? 's' : ''}
              </span>
              <button onClick={clearAll} className="text-sm text-[#f9f9f9] hover:text-[#FFB566] transition-colors">
                Clear all
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {files.map((file, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-2 px-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors">
                  <span className="text-[#f9f9f9]">🎥 {file.name}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-[#CCCCCC]">{formatSize(file.size)}</span>
                    <button onClick={() => removeFile(i)} className="text-[#FF6B6B] hover:text-[#FF9C33] text-xs transition-colors">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {files.length > 0 && (
          <div className="bg-white/5 rounded-xl p-6 mb-6 border border-white/10">
            <h3 className="font-medium text-[#f9f9f9] mb-4">Compression Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[#CCCCCC] block mb-2">Quality (CRF): {quality}</label>
                <input
                  type="range"
                  min="18"
                  max="28"
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                  className="w-full accent-[#75BDF0]"
                />
                <div className="flex justify-between text-xs text-[#CCCCCC]">
                  <span>Better (18)</span>
                  <span>Smaller (28)</span>
                </div>
              </div>
              <div>
                <label className="text-sm text-[#CCCCCC] block mb-2">Preset</label>
                <select
                  value={preset}
                  onChange={(e) => setPreset(e.target.value)}
                  className="w-full p-2 bg-white/10 border border-white/20 rounded-lg text-[#f9f9f9] focus:outline-none focus:border-[#75BDF0]"
                >
                  <option value="slow">Slow (better compression)</option>
                  <option value="medium">Medium</option>
                  <option value="fast">Fast</option>
                  <option value="veryfast">Very Fast</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-[#CCCCCC] block mb-2">Resolution</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="w-full p-2 bg-white/10 border border-white/20 rounded-lg text-[#f9f9f9] focus:outline-none focus:border-[#75BDF0]"
                >
                  <option value="original">Original</option>
                  <option value="1080p">1080p (Full HD)</option>
                  <option value="720p">720p (HD)</option>
                  <option value="480p">480p (SD)</option>
                  <option value="360p">360p</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {files.length > 0 && (
          <div className="flex flex-wrap gap-4 mb-8">
            <button
              onClick={handleCompress}
              disabled={compressing}
              className={`px-8 py-3 rounded-4xl font-semibold text-lg transition-all ${
                compressing
                  ? 'bg-[#1a1a1a] text-[#666666] cursor-not-allowed'
                  : 'bg-[#121212] text-[#f9f9f9] hover:scale-105 hover:shadow-lg hover:shadow-[#f9f9f9]/10'
              }`}
            >
              {compressing ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-5 w-5 text-[#f9f9f9]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Compressing...
                </span>
              ) : (
                `Compress All (${files.length} files)`
              )}
            </button>
            <button onClick={clearAll} className="px-8 py-3 rounded-4xl font-semibold text-lg bg-[#121212] text-[#f9f9f9] hover:scale-105 transition-all">
              Clear
            </button>
          </div>
        )}

        {compressing && (
          <div className="bg-white/5 rounded-2xl p-6 border border-white/10 mb-6">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-[#CCCCCC]">Progress</span>
              <span className="text-sm font-medium text-[#75BDF0]">{Math.round(progress)}%</span>
            </div>
            <div className="w-full bg-white/10 rounded-full h-4 overflow-hidden">
              <div className="bg-[#75BDF0] h-4 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-xs text-[#CCCCCC] mt-2 text-center">{progressText}</p>
            <div className="flex justify-center gap-6 mt-3 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-[#666666]">Speed:</span>
                <span className="text-[#75BDF0] font-medium">{speed}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[#666666]">ETA:</span>
                <span className="text-[#FF9C33] font-medium">{eta}</span>
              </div>
            </div>
            <p className="text-xs text-[#666666] mt-2 text-center">
              {files.length > 1 ? `File ${currentFileIndex + 1}/${files.length}` : 'Processing 1 file'}
            </p>
          </div>
        )}

        {results.length > 0 && (
          <div className="bg-white/5 rounded-2xl p-6 border border-white/10 mb-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-[#75BDF0]">
                {results.length} file{results.length > 1 ? 's' : ''} compressed
              </h3>
              <button
                onClick={handleDownloadAll}
                disabled={downloadingAll}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  downloadingAll ? 'bg-[#1a1a1a] text-[#666666] cursor-not-allowed' : 'bg-[#121212] text-[#f9f9f9] hover:scale-105'
                }`}
              >
                {downloadingAll ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4 text-[#f9f9f9]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Downloading...
                  </span>
                ) : (
                  `Download All (${results.length})`
                )}
              </button>
            </div>
            <div className="max-h-60 overflow-y-auto space-y-2">
              {results.map((result, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-2 px-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors">
                  <div className="flex-1">
                    <p className="font-medium text-[#f9f9f9]">{result.originalName}</p>
                    <p className="text-xs text-[#CCCCCC]">
                      {formatSize(result.originalSize)} → {formatSize(result.compressedSize)}
                      <span className="text-[#75BDF0] ml-2">-{result.compressionRatio}%</span>
                    </p>
                  </div>
                  <button onClick={() => handleDownload(result.name)} className="text-[#75BDF0] hover:text-[#A3D3F5] text-sm font-medium transition-colors ml-4">
                    Download
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {failed.length > 0 && (
          <div className="bg-white/5 rounded-2xl p-6 border border-[#FF6B6B]/20 mb-6">
            <h3 className="font-bold text-lg text-[#FF6B6B] mb-2">
              {failed.length} file{failed.length > 1 ? 's' : ''} failed
            </h3>
            <div className="space-y-1">
              {failed.map((item, i) => (
                <div key={i} className="text-sm py-1 px-3 bg-[#FF6B6B]/10 rounded-lg">
                  <span className="text-[#FF6B6B]">{item.name}</span>
                  <span className="text-[#CCCCCC] ml-2">- {item.error}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 text-center text-sm text-[#CCCCCC] border-t border-white/10 pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
            <div className="bg-white/5 rounded-lg p-4">
              <p className="font-medium text-[#f9f9f9] mb-1">Quality (CRF)</p>
              <p className="text-xs text-[#CCCCCC]"><span className="text-[#75BDF0]">18</span> = near lossless quality</p>
              <p className="text-xs text-[#CCCCCC]"><span className="text-[#FF9C33]">23</span> = good balance</p>
              <p className="text-xs text-[#CCCCCC]"><span className="text-[#FF6B6B]">28</span> = smaller file size</p>
            </div>
            <div className="bg-white/5 rounded-lg p-4">
              <p className="font-medium text-[#f9f9f9] mb-1">Preset</p>
              <p className="text-xs text-[#CCCCCC]"><span className="text-[#75BDF0]">Slow</span> = better compression (takes longer)</p>
              <p className="text-xs text-[#CCCCCC]"><span className="text-[#FF9C33]">Medium</span> = balanced</p>
              <p className="text-xs text-[#CCCCCC]"><span className="text-[#75BDF0]">Fast</span> = quicker (larger file)</p>
            </div>
          </div>
          <p className="mt-4 text-xs text-[#666666]">For 4K video, use CRF 23-28 with Slow preset for best results</p>
        </div>
      </div>
    </main>
  );
}