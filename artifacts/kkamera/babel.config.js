module.exports = function (api) {
  api.cache(true);
  return {
    // import.meta is polyfilled by default (transformImportMeta); the worklets
    // plugin is added automatically when react-native-worklets is installed.
    presets: ["babel-preset-expo"],
  };
};
