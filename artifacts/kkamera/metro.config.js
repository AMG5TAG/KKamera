const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Fix server root for monorepo: ensure HMR resolves from project root,
// not the workspace root, to avoid stale pnpm-store references.
config.server = {
  ...config.server,
  unstable_serverRoot: __dirname,
};

module.exports = config;
