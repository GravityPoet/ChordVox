#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const zlib = require("zlib");

const projectRoot = path.resolve(__dirname, "..");
const pngPath = path.join(projectRoot, "src", "assets", "icon.png");
const icnsPath = path.join(projectRoot, "src", "assets", "icon.icns");
const icoPath = path.join(projectRoot, "src", "assets", "icon.ico");
const builderConfig = require(path.join(projectRoot, "electron-builder.json"));

function fail(message) {
  console.error(`[verify-icons] ${message}`);
  process.exit(1);
}

function readPng(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    fail(`${filePath} is not a PNG file.`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || colorType !== 6) {
    fail(`icon.png must be 8-bit RGBA. Found bitDepth=${bitDepth}, colorType=${colorType}.`);
  }

  const channels = 4;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * channels);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawOffset];
      rawOffset += 1;
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;

      if (filter === 0) {
        pixels[y * stride + x] = value;
      } else if (filter === 1) {
        pixels[y * stride + x] = (value + left) & 0xff;
      } else if (filter === 2) {
        pixels[y * stride + x] = (value + up) & 0xff;
      } else if (filter === 3) {
        pixels[y * stride + x] = (value + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        const predictor = left + up - upLeft;
        const leftDelta = Math.abs(predictor - left);
        const upDelta = Math.abs(predictor - up);
        const upLeftDelta = Math.abs(predictor - upLeft);
        const paeth =
          leftDelta <= upDelta && leftDelta <= upLeftDelta
            ? left
            : upDelta <= upLeftDelta
              ? up
              : upLeft;
        pixels[y * stride + x] = (value + paeth) & 0xff;
      } else {
        fail(`icon.png uses unsupported PNG filter ${filter}.`);
      }
    }
  }

  return { width, height, pixels };
}

function alphaAt(png, x, y) {
  return png.pixels[(y * png.width + x) * 4 + 3];
}

function verifyPng() {
  const png = readPng(pngPath);
  if (png.width !== 1024 || png.height !== 1024) {
    fail(`icon.png must be 1024x1024. Found ${png.width}x${png.height}.`);
  }

  const cornerAlpha = [
    alphaAt(png, 0, 0),
    alphaAt(png, png.width - 1, 0),
    alphaAt(png, 0, png.height - 1),
    alphaAt(png, png.width - 1, png.height - 1),
  ];
  if (!cornerAlpha.every((alpha) => alpha === 0)) {
    fail(`icon.png corners must be transparent. Found alpha values ${cornerAlpha.join(", ")}.`);
  }

  const centerAlpha = alphaAt(png, Math.floor(png.width / 2), Math.floor(png.height / 2));
  if (centerAlpha !== 255) {
    fail(`icon.png center must be opaque. Found alpha=${centerAlpha}.`);
  }
}

function verifyIco() {
  const buffer = fs.readFileSync(icoPath);
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    fail("icon.ico has an invalid ICO header.");
  }

  const expectedSizes = new Set([16, 24, 32, 48, 64, 128, 256]);
  const count = buffer.readUInt16LE(4);
  const foundSizes = new Set();

  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    const bitCount = buffer.readUInt16LE(offset + 6);
    const imageSize = buffer.readUInt32LE(offset + 8);
    const imageOffset = buffer.readUInt32LE(offset + 12);
    const pngSignature = buffer.subarray(imageOffset, imageOffset + 8).toString("hex");

    if (width !== height || bitCount !== 32 || pngSignature !== "89504e470d0a1a0a") {
      fail(`icon.ico entry ${index} is invalid.`);
    }

    if (imageOffset + imageSize > buffer.length) {
      fail(`icon.ico entry ${index} points past the end of the file.`);
    }

    foundSizes.add(width);
  }

  for (const size of expectedSizes) {
    if (!foundSizes.has(size)) {
      fail(`icon.ico is missing ${size}x${size}.`);
    }
  }
}

function verifyIcns() {
  const buffer = fs.readFileSync(icnsPath);
  if (buffer.subarray(0, 4).toString("ascii") !== "icns") {
    fail("icon.icns has an invalid ICNS header.");
  }

  if (process.platform !== "darwin") {
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-icon-"));
  try {
    execFileSync("iconutil", ["-c", "iconset", icnsPath, "-o", path.join(tmpDir, "icon.iconset")], {
      stdio: "ignore",
    });
    const expectedFiles = [
      "icon_16x16.png",
      "icon_16x16@2x.png",
      "icon_32x32.png",
      "icon_32x32@2x.png",
      "icon_128x128.png",
      "icon_128x128@2x.png",
      "icon_256x256.png",
      "icon_256x256@2x.png",
      "icon_512x512.png",
      "icon_512x512@2x.png",
    ];
    for (const fileName of expectedFiles) {
      if (!fs.existsSync(path.join(tmpDir, "icon.iconset", fileName))) {
        fail(`icon.icns is missing ${fileName}.`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function verifyBuilderConfig() {
  const expectations = [
    ["mac.icon", builderConfig.mac?.icon, "src/assets/icon.icns"],
    ["win.icon", builderConfig.win?.icon, "src/assets/icon.ico"],
    ["linux.icon", builderConfig.linux?.icon, "src/assets/icon.png"],
    ["dmg.icon", builderConfig.dmg?.icon, "src/assets/icon.icns"],
  ];

  for (const [label, actual, expected] of expectations) {
    if (actual !== expected) {
      fail(`electron-builder.json ${label} must be ${expected}. Found ${actual || "<missing>"}.`);
    }
  }
}

verifyPng();
verifyIco();
verifyIcns();
verifyBuilderConfig();

console.log("[verify-icons] App icon assets and platform packaging references are valid.");
