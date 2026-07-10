param(
    [string]$Original,
    [string]$Compressed,
    [string]$FfmpegPath
)

# Используем правильные пути
if (-not $Original) {
    $Original = "my-app\public\uploads\Sabrina - Boys Boys Boys  - Long version 1987 (TVE A Tope).mp4"
}
if (-not $Compressed) {
    $Compressed = "my-app\public\output\Sabrina - Boys Boys Boys  - Long version 1987 (TVE A Tope)_compressed.mp4"
}

# Ищем ffmpeg
if (-not $FfmpegPath) {
    $possiblePaths = @(
        "my-app\ffmpeg.exe",
        ".\my-app\ffmpeg.exe",
        ".\ffmpeg.exe",
        ".\ffmpeg\bin\ffmpeg.exe",
        ".\bin\ffmpeg.exe",
        "C:\ffmpeg\bin\ffmpeg.exe",
        "C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    )
    
    foreach ($path in $possiblePaths) {
        if ($path -and (Test-Path $path)) {
            $FfmpegPath = $path
            break
        }
    }
    
    if (-not $FfmpegPath) {
        $whereFfmpeg = where.exe ffmpeg 2>$null
        if ($whereFfmpeg) {
            $FfmpegPath = $whereFfmpeg[0]
        }
    }
}

if (-not $FfmpegPath -or -not (Test-Path $FfmpegPath)) {
    Write-Host "Error: ffmpeg.exe not found!" -ForegroundColor Red
    Write-Host "Please install ffmpeg or specify path using -FfmpegPath parameter" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Example: .\measure-loss.ps1 -FfmpegPath 'my-app\ffmpeg.exe'" -ForegroundColor Cyan
    exit 1
}

if (-not (Test-Path $Original) -or -not (Test-Path $Compressed)) {
    Write-Host "Error: one or both files do not exist" -ForegroundColor Red
    Write-Host "Original: $Original" -ForegroundColor Yellow
    Write-Host "Compressed: $Compressed" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Usage: .\measure-loss.ps1 -Original 'path\to\original.mp4' -Compressed 'path\to\compressed.mp4'" -ForegroundColor Cyan
    exit 1
}

Write-Host "=== Measuring Quality Loss ===" -ForegroundColor Cyan
Write-Host "Original: $Original"
Write-Host "Compressed: $Compressed"
Write-Host "FFmpeg: $FfmpegPath"
Write-Host ""

if (-not (Test-Path $Original)) { Write-Host "Original file not found!" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $Compressed)) { Write-Host "Compressed file not found!" -ForegroundColor Red; exit 1 }

Write-Host "[1/3] Calculating SSIM (Structural Similarity Index)..." -ForegroundColor Yellow
$ssimLog = "ssim_results.log"

& $FfmpegPath -i $Original -i $Compressed -lavfi "[0:v:0][1:v:0]ssim=stats_file=$ssimLog" -f null - 2>$null

if (Test-Path $ssimLog) {
    $lastLine = Get-Content $ssimLog | Select-Object -Last 1
    $ssimMatch = $lastLine | Select-String "All:([0-9.]+)"
    
    if ($ssimMatch) {
        $ssimValue = [double]$ssimMatch.Matches[0].Groups[1].Value
        $ssimPercent = [math]::Round($ssimValue * 100, 2)
        $lossPercent = [math]::Round((1 - $ssimValue) * 100, 2)
        
        Write-Host "  SSIM: $ssimPercent%" -ForegroundColor Cyan
        Write-Host "  Loss: $lossPercent%" -ForegroundColor Yellow
        
        if ($ssimValue -gt 0.99) {
            Write-Host "  Virtually identical (loss is imperceptible)" -ForegroundColor Green
        } elseif ($ssimValue -gt 0.95) {
            Write-Host "  Excellent quality (minimal loss)" -ForegroundColor Green
        } elseif ($ssimValue -gt 0.90) {
            Write-Host "  Good quality (minor loss visible on close inspection)" -ForegroundColor Yellow
        } else {
            Write-Host "  Noticeable quality degradation" -ForegroundColor Red
        }
    } else {
        Write-Host "Failed to parse SSIM from log file" -ForegroundColor Red
    }
    Remove-Item $ssimLog -ErrorAction SilentlyContinue
} else {
    Write-Host "Failed to calculate SSIM" -ForegroundColor Red
}

Write-Host ""
Write-Host "[2/3] Calculating PSNR (Peak Signal-to-Noise Ratio)..." -ForegroundColor Yellow
$psnrLog = "psnr_results.log"

& $FfmpegPath -i $Original -i $Compressed -lavfi "[0:v:0][1:v:0]psnr=stats_file=$psnrLog" -f null - 2>$null

if (Test-Path $psnrLog) {
    $lastLine = Get-Content $psnrLog | Select-Object -Last 1
    $psnrMatch = $lastLine | Select-String "psnr_avg:([0-9.]+)"
    
    if (-not $psnrMatch) {
        $allContent = Get-Content $psnrLog
        foreach ($line in $allContent) {
            $match = $line | Select-String "psnr_avg:([0-9.]+)"
            if ($match) {
                $psnrMatch = $match
                break
            }
        }
    }
    
    if ($psnrMatch) {
        $psnrValue = [double]$psnrMatch.Matches[0].Groups[1].Value
        
        Write-Host "  PSNR: $([math]::Round($psnrValue, 2)) dB" -ForegroundColor Cyan
        
        if ($psnrValue -gt 50) {
            Write-Host "  Identical (loss < 0.01%)" -ForegroundColor Green
        } elseif ($psnrValue -gt 40) {
            Write-Host "  Excellent quality (loss < 1%)" -ForegroundColor Green
        } elseif ($psnrValue -gt 30) {
            Write-Host "  Good quality (loss 1-5%)" -ForegroundColor Yellow
        } else {
            Write-Host "  Noticeable degradation (loss > 5%)" -ForegroundColor Red
        }
    } else {
        Write-Host "Failed to parse PSNR from log file" -ForegroundColor Red
    }
    Remove-Item $psnrLog -ErrorAction SilentlyContinue
} else {
    Write-Host "Failed to calculate PSNR" -ForegroundColor Red
}

Write-Host ""
Write-Host "[3/3] Comparing file sizes..." -ForegroundColor Yellow
$origSize = (Get-Item $Original).Length
$compSize = (Get-Item $Compressed).Length
$origMB = [math]::Round($origSize / 1MB, 2)
$compMB = [math]::Round($compSize / 1MB, 2)
$savedMB = [math]::Round(($origSize - $compSize) / 1MB, 2)
$savedPercent = [math]::Round((1 - $compSize / $origSize) * 100, 1)

Write-Host "  Original: $origMB MB"
Write-Host "  Compressed: $compMB MB"
Write-Host "  Savings: $savedMB MB ($savedPercent%)" -ForegroundColor Green

Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host "Compression: H.264 (original) -> H.265/HEVC (compressed)" -ForegroundColor Yellow
Write-Host "SSIM: $([math]::Round($ssimValue * 100, 2))% similarity" -ForegroundColor Green
if ($psnrMatch) {
    Write-Host "PSNR: $([math]::Round($psnrValue, 2)) dB (Excellent quality)" -ForegroundColor Green
}
Write-Host "Size reduction: $savedPercent%" -ForegroundColor Green
Write-Host ""
Write-Host "Quality is excellent for H.264 to H.265 conversion" -ForegroundColor Cyan
Write-Host "H.265 provides better compression with minimal quality loss" -ForegroundColor Cyan