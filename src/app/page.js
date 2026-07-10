'use client';

import { useState, useRef } from 'react';

export default function Home() {
  const [files, setFiles] = useState([]);
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileSelect = (e) => {
    const selected = Array.from(e.target.files || []);
    const valid = selected.filter(
      (f) =>
        f.type === 'image/png' ||
        f.type === 'image/gif' ||
        f.type === 'image/jpeg' ||
        f.name.match(/\.(jpg|jpeg)$/i)
    );
    setFiles(
      valid.map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        file: f,
      }))
    );
    setResult(null);
  };

  const handleConvert = async () => {
    if (files.length === 0) {
      alert('Please select files to convert');
      return;
    }

    setConverting(true);
    setResult(null);

    const formData = new FormData();
    files.forEach((item) => formData.append('files', item.file));
    formData.append('quality', '85');

    try {
      const res = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (data.success) {
        setResult({
          success: data.success || [],
          failed: data.failed || [],
          outputPath: data.outputPath,
        });
      } else {
        alert('Conversion error: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      alert('Error: ' + error.message);
    } finally {
      setConverting(false);
    }
  };

  const handleDownload = (filename) => {
    window.open(`/api/download?file=${encodeURIComponent(filename)}`, '_blank');
  };

  const handleDownloadAll = async () => {
    if (!result || !result.success || result.success.length === 0) {
      alert('No files to download');
      return;
    }

    setDownloading(true);

    try {
      for (let i = 0; i < result.success.length; i++) {
        const filename = result.success[i];
        const link = document.createElement('a');
        link.href = `/api/download?file=${encodeURIComponent(filename)}`;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      alert('Download error: ' + error.message);
    } finally {
      setDownloading(false);
    }
  };

  const clearAll = () => {
    setFiles([]);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const getFileIcon = (file) => {
    if (file.type === 'image/png') return 'PNG';
    if (file.type === 'image/gif') return 'GIF';
    if (file.type === 'image/jpeg' || file.name.match(/\.(jpg|jpeg)$/i)) return 'JPG';
    return 'FILE';
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <main className="min-h-screen bg-[#2d3436] text-[#f9f9f9] p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl text-[#f9f9f9]">
            Image Converter
          </h1>
          <p className="text-[#f9f9f9] mt-2">
            PNG / GIF / JPEG to WEBP conversion for exercise images
          </p>
          <div className="mt-2">
            <a 
              href="/video" 
              className="text-lg text-[#75BDF0] hover:text-[#A3D3F5] transition-colors inline-flex items-center gap-1"
            >
              Try Video Compressor →
            </a>
          </div>
        </div>

        {/* Instructions */}
        <div className="bg-white/5 rounded-xl p-4 mb-6 border border-white/10">
          <div className="flex items-start gap-3">
            <img 
              src="/info.png" 
              alt="Info" 
              className="w-6 h-6 mt-1"
            />
            <div>
              <p className="text-lg text-[#f9f9f9]">How to use:</p>
              <ol className="text-sm text-[#CCCCCC] mt-1 space-y-1 list-decimal list-inside">
                <li>Click the upload area or drag & drop PNG, GIF, or JPEG files</li>
                <li>Click <span className="text-[#f9f9f9]">Convert</span> to start conversion to WEBP</li>
                <li>Download individual files or use <span className="text-[#f9f9f9]">Download all</span></li>
              </ol>
            </div>
          </div>
        </div>

        {/* Upload Card */}
        <div className="bg-white/5 backdrop-blur-sm rounded-2xl p-8 border border-white/10 mb-6">
          <div
            className="border-2 border-dashed border-[#f9f9f9] rounded-2xl p-10 text-center cursor-pointer hover:border-[#FF9C33] transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.gif,.jpg,.jpeg,image/png,image/gif,image/jpeg"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="text-5xl mb-4 text-[#f9f9f9]">📁</div>
            <p className="text-lg font-medium">Click to select files</p>
            <p className="text-sm text-[#f9f9f9] mt-1">
              Supports PNG, GIF, JPEG (multiple files allowed)
            </p>
            {files.length > 0 && (
              <p className="text-[#f9f9f9] mt-3 font-medium">
                Selected: {files.length} file{files.length > 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>

        {/* File List */}
        {files.length > 0 && (
          <div className="bg-white/5 rounded-xl p-4 mb-6 border border-white/10">
            <div className="flex justify-between items-center mb-3">
              <span className="font-medium text-[#f9f9f9]">
                Selected {files.length} file{files.length > 1 ? 's' : ''}
              </span>
              <button
                onClick={clearAll}
                className="text-sm text-[#f9f9f9] hover:text-[#FFB566] transition-colors"
              >
                Clear all
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {files.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-sm py-2 px-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                >
                  <span className="text-[#f9f9f9]">
                    [{getFileIcon(file)}] {file.name}
                  </span>
                  <span className="text-xs text-[#CCCCCC]">
                    {formatSize(file.size)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-4 mb-8">
          <button
            onClick={handleConvert}
            disabled={files.length === 0 || converting}
            className={`
              px-8 py-3 rounded-4xl font-semibold text-lg transition-all
              ${
                files.length === 0 || converting
                  ? 'bg-[#1a1a1a] text-[#666666] cursor-not-allowed'
                  : 'bg-[#121212] text-[#f9f9f9] hover:scale-105 hover:shadow-lg hover:shadow-[#f9f9f9]/10'
              }
            `}
          >
            {converting ? (
              <span className="flex items-center gap-2">
                <svg 
                  className="animate-spin h-5 w-5 text-[#f9f9f9]" 
                  xmlns="http://www.w3.org/2000/svg" 
                  fill="none" 
                  viewBox="0 0 24 24"
                >
                  <circle 
                    className="opacity-25" 
                    cx="12" 
                    cy="12" 
                    r="10" 
                    stroke="currentColor" 
                    strokeWidth="4"
                  />
                  <path 
                    className="opacity-75" 
                    fill="currentColor" 
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Converting...
              </span>
            ) : (
              'Convert'
            )}
          </button>

          {result && result.success && result.success.length > 0 && (
            <button
              onClick={handleDownloadAll}
              disabled={downloading}
              className={`
                px-8 py-3 rounded-4xl font-semibold text-lg transition-all
                ${
                  downloading
                    ? 'bg-[#1a1a1a] text-[#666666] cursor-not-allowed'
                    : 'bg-[#121212] text-[#f9f9f9] hover:scale-105 hover:shadow-lg hover:shadow-[#f9f9f9]/10'
                }
              `}
            >
              {downloading ? (
                <span className="flex items-center gap-2">
                  <svg 
                    className="animate-spin h-5 w-5 text-[#f9f9f9]" 
                    xmlns="http://www.w3.org/2000/svg" 
                    fill="none" 
                    viewBox="0 0 24 24"
                  >
                    <circle 
                      className="opacity-25" 
                      cx="12" 
                      cy="12" 
                      r="10" 
                      stroke="currentColor" 
                      strokeWidth="4"
                    />
                    <path 
                      className="opacity-75" 
                      fill="currentColor" 
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Downloading...
                </span>
              ) : (
                `Download all (${result.success.length} files)`
              )}
            </button>
          )}

          {result && result.failed && result.failed.length > 0 && (
            <button
              onClick={() => alert('Errors:\n' + result.failed.join('\n'))}
              className="px-8 py-3 rounded-4xl font-semibold text-lg bg-[#121212] text-[#f9f9f9] hover:scale-105 transition-all"
            >
              Show errors ({result.failed.length})
            </button>
          )}
        </div>

        {/* Result */}
        {result && (
          <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
            <h3 className="font-bold text-lg text-[#f9f9f9] mb-4">Conversion Result</h3>

            {result.success && result.success.length > 0 && (
              <div className="mb-4">
                <p className="text-[#75BDF0] font-medium mb-2">
                  Success: {result.success.length} files
                </p>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {result.success.map((name, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between text-sm py-2 px-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                    >
                      <span className="text-[#f9f9f9]">{name}</span>
                      <button
                        onClick={() => handleDownload(name)}
                        className="text-[#75BDF0] hover:text-[#A3D3F5] text-sm font-medium transition-colors"
                      >
                        Download
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.failed && result.failed.length > 0 && (
              <div>
                <p className="text-[#FF6B6B] font-medium mb-2">
                  Failed: {result.failed.length} files
                </p>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {result.failed.map((name, i) => (
                    <div
                      key={i}
                      className="text-sm py-2 px-3 bg-[#FF6B6B]/10 rounded-lg border border-[#FF6B6B]/20 text-[#FF6B6B]"
                    >
                      {name}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}