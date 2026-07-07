const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Force Metro to resolve from the project directory, not the workspace root.
// This prevents stale pnpm hash references from the workspace-level .pnpm store.
config.projectRoot = __dirname;

// Disable all persistent caches to prevent stale module resolution.
config.resetCache = true;
config.cacheStores = [];
config.cacheVersion = "v" + Date.now();

module.exports = config;
