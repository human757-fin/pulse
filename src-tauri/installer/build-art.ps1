$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot

function Color([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }
function Brush([string]$hex) { [Drawing.SolidBrush]::new((Color $hex)) }

function Draw-Mark($g, [single]$x, [single]$y, [single]$size, [switch]$uninstall) {
    $state = $g.Save()
    $g.TranslateTransform($x, $y)
    $g.ScaleTransform($size / 64, $size / 64)
    $tile = [Drawing.Drawing2D.GraphicsPath]::new()
    $tile.AddArc(2, 2, 28, 28, 180, 90)
    $tile.AddArc(34, 2, 28, 28, 270, 90)
    $tile.AddArc(34, 34, 28, 28, 0, 90)
    $tile.AddArc(2, 34, 28, 28, 90, 90)
    $tile.CloseFigure()
    $background = Brush '#192131'
    $arc = Brush '#a7c9ff'
    $play = Brush '#e7f2ff'
    $bubble = [Drawing.Drawing2D.GraphicsPath]::new()
    try {
        $g.FillPath($background, $tile)
        $g.FillEllipse($arc, 11, 11, 42, 42)
        $g.FillEllipse($background, [single]22, [single]16.5, [single]31, [single]31)
        $bubble.AddLine(34, 25, 45, 25)
        $bubble.AddArc(41, 25, 8, 8, 270, 90)
        $bubble.AddLine(49, 29, 49, 35)
        $bubble.AddArc(41, 31, 8, 8, 0, 90)
        $bubble.AddLine(45, 39, 39, 39)
        $bubble.AddLine([single]39, [single]39, [single]35.3, [single]42)
        $bubble.AddBezier([single]35.3, [single]42, [single]34.8, [single]42.4, [single]34, [single]42, [single]34, [single]41.38)
        $bubble.AddLine([single]34, [single]41.38, [single]34, [single]39)
        $bubble.AddArc(30, 31, 8, 8, 90, 90)
        $bubble.AddLine(30, 35, 30, 29)
        $bubble.AddArc(30, 25, 8, 8, 180, 90)
        $bubble.CloseFigure()
        $g.FillPath($play, $bubble)
        if ($uninstall) {
            $badge = Brush '#e7f2ff'
            try {
                $g.FillEllipse($background, 41, 41, 23, 23)
                $g.FillEllipse($badge, 43, 43, 19, 19)
                $g.FillRectangle($background, 47, 51, 11, 3)
            } finally { $badge.Dispose() }
        }
    } finally {
        $tile.Dispose(); $bubble.Dispose()
        $background.Dispose(); $arc.Dispose(); $play.Dispose()
        $g.Restore($state)
    }
}

function Draw-Sidebar($g, [int]$height) {
    $rect = [Drawing.Rectangle]::new(0, 0, 164, $height)
    $gradient = [Drawing.Drawing2D.LinearGradientBrush]::new($rect, (Color '#121927'), (Color '#263b57'), 35)
    $ring = [Drawing.Pen]::new((Color '#3c5578'), 1)
    $word = [Drawing.Font]::new('Segoe UI', 26, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $white = Brush '#e7f2ff'
    $clip = $g.Save()
    try {
        $g.SetClip($rect)
        $g.FillRectangle($gradient, $rect)
        foreach ($diameter in @(220, 246, 272, 298)) {
            $g.DrawEllipse($ring, 127 - $diameter / 2, 237 - $diameter / 2, $diameter, $diameter)
        }
        Draw-Mark $g 23 44 71
        $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $g.DrawString('Umbra', $word, $white, 24, 122)
    } finally {
        $g.Restore($clip)
        $gradient.Dispose(); $ring.Dispose(); $word.Dispose(); $white.Dispose()
    }
}

function New-ArtBitmap([int]$width, [int]$height, [Drawing.Imaging.PixelFormat]$format, [scriptblock]$render) {
    $scale = 4
    $master = [Drawing.Bitmap]::new($width * $scale, $height * $scale, $format)
    $g = [Drawing.Graphics]::FromImage($master)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.ScaleTransform($scale, $scale)
    $image = [Drawing.Bitmap]::new($width, $height, $format)
    $output = [Drawing.Graphics]::FromImage($image)
    try {
        & $render $g
        $output.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $output.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $output.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
        $edge = [Drawing.Imaging.ImageAttributes]::new()
        try {
            $edge.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $bounds = [Drawing.Rectangle]::new(0, 0, $width, $height)
            $output.DrawImage($master, $bounds, 0, 0, $master.Width, $master.Height, [Drawing.GraphicsUnit]::Pixel, $edge)
        } finally { $edge.Dispose() }
        return $image
    } catch {
        $image.Dispose()
        throw
    } finally { $output.Dispose(); $g.Dispose(); $master.Dispose() }
}

function Save-Bitmap([string]$name, [int]$width, [int]$height, [scriptblock]$paint) {
    $image = New-ArtBitmap $width $height Format24bppRgb {
        param($g)
        $g.Clear((Color '#ffffff'))
        & $paint $g
    }
    try {
        $image.Save((Join-Path $PSScriptRoot $name), [Drawing.Imaging.ImageFormat]::Bmp)
    } finally { $image.Dispose() }
}

function Write-IconBitmap($image, $stream) {
    $size = $image.Width
    $writer = [IO.BinaryWriter]::new($stream, [Text.Encoding]::UTF8, $true)
    try {
        $writer.Write([uint32]40)
        $writer.Write([int]$size)
        $writer.Write([int](2 * $size))
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([byte[]]::new(24))
        $stride = [int]([Math]::Ceiling($size / 32) * 4)
        $mask = [byte[]]::new($stride * $size)
        for ($y = $size - 1; $y -ge 0; $y--) {
            for ($x = 0; $x -lt $size; $x++) {
                $pixel = $image.GetPixel($x, $y)
                $writer.Write([byte]$pixel.B)
                $writer.Write([byte]$pixel.G)
                $writer.Write([byte]$pixel.R)
                $writer.Write([byte]$pixel.A)
                if ($pixel.A -eq 0) {
                    $index = ($size - 1 - $y) * $stride + ($x -shr 3)
                    $mask[$index] = $mask[$index] -bor (128 -shr ($x -band 7))
                }
            }
        }
        $writer.Write($mask)
    } finally { $writer.Dispose() }
}

function Save-Icon([string]$filename, [switch]$uninstall) {
    $entries = foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
        $image = New-ArtBitmap $size $size Format32bppArgb { param($g) Draw-Mark $g 0 0 $size -Uninstall:$uninstall }
        $stream = [IO.MemoryStream]::new()
        try {
            if ($size -eq 256) { $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png) }
            else { Write-IconBitmap $image $stream }
            @{ Size = $size; Bytes = $stream.ToArray() }
        } finally { $stream.Dispose(); $image.Dispose() }
    }
    $writer = [IO.BinaryWriter]::new([IO.File]::Create($filename))
    try {
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$entries.Count)
        $offset = 6 + 16 * $entries.Count
        foreach ($entry in $entries) {
            $writer.Write([byte]($entry.Size % 256))
            $writer.Write([byte]($entry.Size % 256))
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$entry.Bytes.Length)
            $writer.Write([uint32]$offset)
            $offset += $entry.Bytes.Length
        }
        foreach ($entry in $entries) { $writer.Write([byte[]]$entry.Bytes) }
    } finally { $writer.Dispose() }
}

Save-Icon (Join-Path $root 'icons/icon.ico')
$logo = New-ArtBitmap 256 256 Format32bppArgb { param($g) Draw-Mark $g 0 0 256 }
try { $logo.Save((Join-Path $root 'icons/icon.png'), [Drawing.Imaging.ImageFormat]::Png) } finally { $logo.Dispose() }
Save-Icon (Join-Path $PSScriptRoot 'uninstall.ico') -Uninstall
Save-Bitmap 'nsis-sidebar.bmp' 164 314 { param($g) Draw-Sidebar $g 314 }
Save-Bitmap 'nsis-header.bmp' 150 57 { param($g) Draw-Mark $g 101 7 43 }
Save-Bitmap 'nsis-uninstall-header.bmp' 150 57 { param($g) Draw-Mark $g 101 7 43 -Uninstall }
Save-Bitmap 'msi-banner.bmp' 493 58 { param($g) Draw-Mark $g 435 7 44 }
Save-Bitmap 'msi-dialog.bmp' 493 312 { param($g) Draw-Sidebar $g 312 }
