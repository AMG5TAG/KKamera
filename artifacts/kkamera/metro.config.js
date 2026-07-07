const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// pnpm hoists dependencies to the workspace-root store
// (../../node_modules/.pnpm/...). Metro's serverRoot MUST be an ancestor of
// every file it serves, so it has to stay at the workspace root — which is
// what expo/metro-config auto-detects by default.
//
// Do NOT force serverRoot/projectRoot to __dirname: the actual dependency
// files live two directories ABOVE this package, so a __dirname serverRoot
// makes Metro emit bundle URLs that climb out with `../../` (e.g.
// https://<host>/../../node_modules/.pnpm/expo-router@.../entry.bundle).
// That path traversal is illegal in a URL — the client/proxy normalizes it
// past the domain root, the request misses Metro's bundle endpoint, and
// React Native reports "Could not connect to development server".
//
// The pnpm-hash churn this file used to fight (stale cached hash paths →
// "UnableToResolveError") is handled below by the stale-hash resolver
// interceptor plus cache-busting, not by breaking serverRoot.
//
// Add workspace root to watchFolders for SHA-1 computation.
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
