const { withDangerousMod, withAppBuildGradle, withAppDelegate } = require("@expo/config-plugins");
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

// iOS: Route realtime "Talk to Ora" WebRTC audio to the loudspeaker by default.
// react-native-webrtc uses the AVAudioSession playAndRecord category, which iOS
// routes to the quiet earpiece unless the .defaultToSpeaker option is set — and
// there is no JS API to do this. Set it once at launch on react-native-webrtc's
// shared RTCAudioSessionConfiguration so every realtime call defaults to the
// speaker; .allowBluetooth(A2DP) keeps AirPods/headsets winning when connected.
function withWebRTCSpeakerRouting(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") return config;
    let contents = config.modResults.contents;
    const marker = "mustaflow-webrtc-speaker";
    if (contents.includes(marker)) return config;

    // Add the imports needed for RTCAudioSessionConfiguration. Bail without
    // touching anything if the expected anchor is missing, so a template change
    // can never inject a snippet that references an unimported symbol.
    if (!contents.includes("import WebRTC")) {
      if (!contents.includes("import Expo")) return config;
      contents = contents.replace("import Expo", "import Expo\nimport AVFoundation\nimport WebRTC");
    }

    const snippet =
      `\n    // ${marker}: default realtime WebRTC audio to the loudspeaker\n` +
      "    let rtcAudioConfig = RTCAudioSessionConfiguration.webRTC()\n" +
      "    rtcAudioConfig.categoryOptions.insert(.defaultToSpeaker)\n" +
      "    rtcAudioConfig.categoryOptions.insert(.allowBluetooth)\n" +
      "    rtcAudioConfig.categoryOptions.insert(.allowBluetoothA2DP)\n" +
      "    RTCAudioSessionConfiguration.setWebRTC(rtcAudioConfig)\n";

    const didFinish = /(didFinishLaunchingWithOptions[\s\S]*?-> Bool \{)/;
    if (!didFinish.test(contents)) return config;
    contents = contents.replace(didFinish, `$1${snippet}`);

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = (config) => {
  config = withGoogleModularHeaders(config);
  config = withAndroidPackagingFix(config);
  config = withWebRTCSpeakerRouting(config);
  return config;
};
