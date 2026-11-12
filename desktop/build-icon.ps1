$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Same original geometry as public/icon.svg (64-unit grid): rounded tile, open aperture ring, amber point.
# PNG-backed ICO entries preserve alpha at every size.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = [System.Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) {
    $renderSize = $size * 4
    $source = [System.Drawing.Bitmap]::new($renderSize, $renderSize)
    $graphics = [System.Drawing.Graphics]::FromImage($source)
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#17181a'))
    $accent = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#f2b25c'))
    $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#f4f3ef'), 7)
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $outputGraphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = [System.IO.MemoryStream]::new()
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.ScaleTransform($renderSize / 64.0, $renderSize / 64.0)
        # Rounded tile (radius 15 on the 64-unit grid, matching rx="15" in icon.svg).
        $path.AddArc(0, 0, 30, 30, 180, 90)
        $path.AddArc(34, 0, 30, 30, 270, 90)
        $path.AddArc(34, 34, 30, 30, 0, 90)
        $path.AddArc(0, 34, 30, 30, 90, 90)
        $path.CloseFigure()
        $graphics.FillPath($background, $path)
        # Aperture ring: centre (32,32), r=15, opening 96 degrees on the right (-48..+48 degrees).
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawArc($pen, 17, 17, 30, 30, 48, 264)
        # Amber point inside the opening: centre (46.5,32), r=4.5.
        $graphics.FillEllipse($accent, 42, 27.5, 9, 9)
        $outputGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $outputGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $outputGraphics.DrawImage($source, 0, 0, $size, $size)
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images.Add($stream.ToArray())
    }
    finally {
        $stream.Dispose()
        $outputGraphics.Dispose()
        $bitmap.Dispose()
        $pen.Dispose()
        $background.Dispose()
        $accent.Dispose()
        $path.Dispose()
        $graphics.Dispose()
        $source.Dispose()
    }
}

$iconPath = Join-Path $PSScriptRoot 'app.ico'
$file = [System.IO.File]::Create($iconPath)
$writer = [System.IO.BinaryWriter]::new($file)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$images[$i].Length)
        $writer.Write([uint32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($bytes in $images) { $writer.Write($bytes) }
}
finally { $writer.Dispose() }

# Decode every actual ICO payload and check directory dimensions and boundaries.
$bytes = [System.IO.File]::ReadAllBytes($iconPath)
if ([BitConverter]::ToUInt16($bytes, 2) -ne 1 -or [BitConverter]::ToUInt16($bytes, 4) -ne $sizes.Count) {
    throw 'Invalid ICO header'
}
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $entry = 6 + 16 * $i
    $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
    $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
    if ($length -eq 0 -or $offset + $length -gt $bytes.Length) { throw 'Invalid ICO payload bounds' }
    $stream = [System.IO.MemoryStream]::new($bytes, [int]$offset, [int]$length)
    $image = [System.Drawing.Image]::FromStream($stream)
    try {
        $dimension = if ($bytes[$entry] -eq 0) { 256 } else { [int]$bytes[$entry] }
        $height = if ($bytes[$entry + 1] -eq 0) { 256 } else { [int]$bytes[$entry + 1] }
        if ($dimension -ne $sizes[$i] -or $height -ne $sizes[$i] -or $image.Width -ne $dimension -or $image.Height -ne $height) {
            throw 'ICO dimensions do not match'
        }
        Write-Output ("Verified {0}x{0}: {1} PNG bytes" -f $dimension, $length)
    }
    finally { $image.Dispose(); $stream.Dispose() }
}
Write-Output ("Created {0}: {1} bytes" -f $iconPath, $bytes.Length)
