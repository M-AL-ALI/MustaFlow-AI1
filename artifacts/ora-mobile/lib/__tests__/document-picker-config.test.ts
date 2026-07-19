import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the iOS "Upload failed — Could not open the file picker"
// TestFlight bug: expo-document-picker requires the iCloud Documents entitlement
// on real iOS builds (Expo Go masks this in development). The entitlement comes
// from ios.usesIcloudStorage plus the expo-document-picker config plugin with an
// iCloudContainerEnvironment. If either is removed, the Files picker throws on
// open in TestFlight/App Store builds while still working in development.

type ExpoPluginEntry = string | [string, Record<string, unknown>?];

interface ExpoAppConfig {
  expo: {
    ios?: {
      usesIcloudStorage?: boolean;
    };
    plugins?: ExpoPluginEntry[];
  };
}

const appJsonPath = join(__dirname, "..", "..", "app.json");
const appConfig = JSON.parse(
  readFileSync(appJsonPath, "utf8").replace(/\r\n/g, "\n"),
) as ExpoAppConfig;

describe("document picker iOS entitlement config", () => {
  it("keeps ios.usesIcloudStorage enabled so the Files picker can open on device builds", () => {
    expect(appConfig.expo.ios?.usesIcloudStorage).toBe(true);
  });

  it("registers the expo-document-picker config plugin with an iCloud container environment", () => {
    const plugins = appConfig.expo.plugins ?? [];
    const entry = plugins.find(
      (p): p is [string, Record<string, unknown>] =>
        Array.isArray(p) && p[0] === "expo-document-picker",
    );
    expect(entry, "expo-document-picker plugin entry missing from app.json plugins").toBeDefined();
    expect(entry?.[1]?.iCloudContainerEnvironment).toBe("Production");
  });

  it("keeps expo-document-picker as a direct dependency", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.["expo-document-picker"]).toBeTruthy();
  });
});
