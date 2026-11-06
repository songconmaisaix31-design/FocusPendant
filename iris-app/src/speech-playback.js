"use strict";

const crypto = require("node:crypto");

// Read RIFF chunks rather than assuming every generated WAV has a 44-byte header.
function parseWave(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid WAV");
  let format, dataSize;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) throw new Error("Truncated WAV");
    if (type === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format");
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    } else if (type === "data") dataSize = size;
    offset = start + size + (size % 2);
  }
  if (!format || !dataSize || format.encoding !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || format.blockAlign !== format.channels * 2 || format.sampleRate < 8000 || format.sampleRate > 192000 || dataSize % format.blockAlign) throw new Error("Unsupported WAV format");
  const durationUs = Math.round(dataSize / format.blockAlign / format.sampleRate * 1e6);
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) throw new Error("Invalid WAV duration");
  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), durationUs, sourceSampleRate: format.sampleRate, channels: format.channels };
}

module.exports = { parseWave };
