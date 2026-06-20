const { withDangerousMod, withAppBuildGradle } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// iOS: Add use_modular_headers! globally before install! to fix AppCheckCore issue.
// AppCheckCore (Swift, from @clerk/expo → GoogleSignIn) needs GoogleUtilities +
// RecaptchaInterop to expose module maps; use_modular_headers! is the authoritative fix.
function withGoogleModularHeaders(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, "Podfile");
      if (!fs.existsSync(podfilePath)) return config;
      let contents = fs.readFileSync(podfilePath, "utf8");
      if (contents.includes("use_modular_headers!")) return config;
      // Insert use_modular_headers! on its own line before `install! 'cocoapods'`
      if (contents.includes("install! 'cocoapods'")) {
        contents = contents.replace(
          "install! 'cocoapods'",
          "use_modular_headers!\n\ninstall! 'cocoapods'",
        );
      } else {
        // Fallback: insert before target block
        contents = contents.replace(/^(target '[^']+' do)$/m, "use_modular_headers!\n\n$1");
      }
      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

// Android: Fix duplicate META-INF/versions/9/OSGI-INF/MANIFEST.MF between
// okhttp3:logging-interceptor and jspecify at the mergeReleaseJavaResource Gradle task.
function withAndroidPackagingFix(config) {
  return withAppBuildGradle(config, (config) => {
    const marker = "// mustaflow-packaging-fix";
    if (config.modResults.contents.includes(marker)) return config;
    config.modResults.contents = config.modResults.contents.replace(
      /android\s*\{/,
      `android {\n    ${marker}\n    packagingOptions {\n        pickFirst 'META-INF/versions/9/OSGI-INF/MANIFEST.MF'\n    }`,
    );
    return config;
  });
}

module.exports = (config) => {
  config = withGoogleModularHeaders(config);
  config = withAndroidPackagingFix(config);
  return config;
};
