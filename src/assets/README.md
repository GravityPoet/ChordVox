# Assets Directory

This directory contains app icons and other assets for ChordVox.

## Required Icons

For proper app packaging, you'll need the following icon files:

- `icon.icns` - macOS application and DMG icon
- `icon.ico` - Windows executable and installer icon
- `icon.png` - Linux icon and renderer UI logo source

## Icon Specifications

- **Source PNG (`icon.png`)**: 1024x1024 pixels, RGBA alpha, transparent outside the rounded app tile.
- **macOS (`icon.icns`)**: generated from the 1024x1024 source PNG with a complete iconset.
- **Windows (`icon.ico`)**: contains 16, 24, 32, 48, 64, 128, and 256 px RGBA PNG entries.
- **Linux (`icon.png`)**: uses the same 1024x1024 RGBA source PNG.

## Creating Icons

You can create these icons using:

- Online converters like https://convertio.co/
- Design tools like Figma, Sketch, or Photoshop
- Command line tools like ImageMagick

## Packaging

`electron-builder.json` intentionally references platform-specific files:

- macOS / DMG: `src/assets/icon.icns`
- Windows: `src/assets/icon.ico`
- Linux: `src/assets/icon.png`

Do not export transparency previews with checkerboard backgrounds baked into the PNG; that causes visible icon changes on some macOS and Windows surfaces.
