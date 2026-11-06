"use strict";

const fs = require("node:fs");
const path = require("node:path");

function applicationDataDirectory() {
  const directory = process.env.FUSIONUI_APP_DATA_DIR;
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("IrisView application data directory is unavailable");
  }
  fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
  return directory;
}

function applicationDataPath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Application data path must be relative");
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Application data path escapes its private directory");
  }
  return path.join(applicationDataDirectory(), normalized);
}

module.exports = { applicationDataDirectory, applicationDataPath };
