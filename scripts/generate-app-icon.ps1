param(
  [string]$SourcePath = (Join-Path (Split-Path -Parent $PSScriptRoot) "build\icon-source.png")
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$appRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $appRoot "build"
$pngPath = Join-Path $outputDirectory "icon.png"
$icoPath = Join-Path $outputDirectory "icon.ico"
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
  throw "ICON_SOURCE_NOT_FOUND: $SourcePath"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = [System.Drawing.Image]::FromFile($SourcePath)

try {
  if ($source.Width -ne $source.Height -or $source.Width -lt 256) {
    throw "ICON_SOURCE_INVALID: expected a square image of at least 256x256 pixels."
  }

  $pngBitmap = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($pngBitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, 512, 512)
    } finally {
      $graphics.Dispose()
    }
    $pngBitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $pngBitmap.Dispose()
  }

  $images = foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($source, 0, 0, $size, $size)
      } finally {
        $graphics.Dispose()
      }

      $stream = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        [PSCustomObject]@{ Size = $size; Bytes = $stream.ToArray() }
      } finally {
        $stream.Dispose()
      }
    } finally {
      $bitmap.Dispose()
    }
  }

  $file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $writer = [System.IO.BinaryWriter]::new($file)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$images.Count)
    $offset = 6 + (16 * $images.Count)

    foreach ($image in $images) {
      $dimension = if ($image.Size -eq 256) { 0 } else { $image.Size }
      $writer.Write([Byte]$dimension)
      $writer.Write([Byte]$dimension)
      $writer.Write([Byte]0)
      $writer.Write([Byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$image.Bytes.Length)
      $writer.Write([UInt32]$offset)
      $offset += $image.Bytes.Length
    }

    foreach ($image in $images) {
      $writer.Write($image.Bytes)
    }
  } finally {
    $writer.Dispose()
    $file.Dispose()
  }
} finally {
  $source.Dispose()
}

Write-Output $pngPath
Write-Output $icoPath
