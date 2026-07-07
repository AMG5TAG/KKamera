const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// PERMANENT FIX: expo/metro-config auto-detects the workspace root and sets
// server.unstable_serverRoot to the workspace root. This causes bundle URLs
// and HMR entry points to be relative to the workspace root, which embeds the
// full pnpm hash (e.g. node_modules/.pnpm/expo-router@6.0.24_@types+react-dom@19.2.3_.../entry).
// When dependencies change, the hash changes but browser/Metro caches still
// hold the OLD hash path, causing "UnableToResolveError".
//
// Fix layers:
// 1. Force projectRoot and serverRoot to the actual project directory so
//    paths are stable: node_modules/expo-router/entry (via pnpm symlink).
// 2. Add a custom resolver that intercepts stale pnpm-hashed paths from
//    browser HMR reconnections and rewrites them to stable symlink paths.
// 3. Add workspace root to watchFolders for SHA-1 computation.

config.projectRoot = __dirname;

config.server = config.server || {};
config.server.unstable_serverRoot = __dirname;

config.watchFolders = [
  ...(config.watchFolders || []),
  path.resolve(__dirname, "../.."),
];

// ---- RESOLVER INTERCEPTOR: rewrite stale pnpm hash paths ----
// When a browser reconnects to HMR after a pnpm install changed hashes,
// it may send entry points with old pnpm hash paths like:
//   ./node_modules/.pnpm/expo-router@6.0.23_...hash.../node_modules/expo-router/entry
// This interceptor catches those paths and rewrites to:
//   node_modules/expo-router/entry  (stable symlink)
//
// Pattern: (./|/)node_modules/.pnpm/<hash-dir>/node_modules/<pkg>/<rest>
// Stable:  node_modules/<pkg>/<rest>
const STALE_PNP_PATTERN =
  /^(?:\.\/|\/)?node_modules\/\.pnpm\/[^/]+\/node_modules\/([^/]+)(\/.*)?$/;

const originalResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const match = moduleName.match(STALE_PNP_PATTERN);
  if (match) {
    const pkgName = match[1];
    const rest = match[2] || "";
    const stablePath = `node_modules/${pkgName}${rest}`;

    // Try to resolve the stable path via Metro's default resolver
    try {
      const result = context.resolveRequest(context, stablePath, platform);
      if (result && result.filePath) {
        return result;
      }
    } catch {
      // If stable path fails, fall through to original resolution
    }
  }

  // Delegate to the original/custom resolver (or Metro default)
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

// Ensure caches are always fresh.
config.resetCache = true;
config.cacheStores = [];
config.cacheVersion = "kkamera-" + Date.now();

module.exports = config;
