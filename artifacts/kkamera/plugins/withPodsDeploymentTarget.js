// Raises every CocoaPods target's IPHONEOS_DEPLOYMENT_TARGET to at least the
// app's minimum (15.1). Xcode 27 refuses to build targets below iOS 15.0, and
// several pods (RevenueCat, SDWebImage, RNSVG, AsyncStorage, ...) still
// declare 9.0–13.4 in their podspecs. Lives in a config plugin so it survives
// `expo prebuild --clean`.
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const MIN_TARGET = "15.1";
const MARKER = "# kkamera: pods deployment target";

const SNIPPET = `
    ${MARKER}
    installer.pods_project.targets.each do |t|
      t.build_configurations.each do |bc|
        current = bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || Gem::Version.new(current) < Gem::Version.new('${MIN_TARGET}')
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_TARGET}'
        end
      end
    end
`;

module.exports = function withPodsDeploymentTarget(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let contents = fs.readFileSync(podfile, "utf8");
      if (!contents.includes(MARKER)) {
        const anchor = /(post_install do \|installer\|\n)/;
        if (!anchor.test(contents)) {
          throw new Error("withPodsDeploymentTarget: post_install hook not found in Podfile");
        }
        contents = contents.replace(anchor, `$1${SNIPPET}`);
        fs.writeFileSync(podfile, contents);
      }
      return cfg;
    },
  ]);
};
