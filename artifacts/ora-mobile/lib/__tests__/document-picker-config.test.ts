import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the iOS "Upload failed - Could not open the file picker"
// TestFlight bug. Root cause: the attach menu is a React Native <Modal>, and iOS
// cannot present the native Files/camera/photo pickers while that Modal is still
// animating its dismissal. The failed presentation leaks expo-document-picker's
// native picking context, so every later attempt instantly rejects until the app
// restarts. The fix defers each menu action until the Modal's onDismiss callback
// fires on iOS. These tests pin that wiring.

const root = join(__dirname, "..", "..");
const indexSource = readFileSync(join(root, "app", "(home)", "index.tsx"), "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("attach menu picker launch wiring", () => {
  it("defers every attach menu action until the plus menu modal has dismissed", () => {
    expect(indexSource).toContain("pendingPlusMenuActionRef");
    expect(indexSource).toContain("const closePlusMenuThen = useCallback");
    expect(indexSource).toMatch(/onBrowseFiles=\{\(\) =>\s*closePlusMenuThen\(/);
    expect(indexSource).toMatch(/onTakePhoto=\{\(\) =>\s*closePlusMenuThen\(/);
    expect(indexSource).toMatch(/onPickPhoto=\{\(\) =>\s*closePlusMenuThen\(/);
    expect(indexSource).toMatch(/onGenerateFile=\{\(\) =>\s*closePlusMenuThen\(/);
  });

  it("wires the plus menu Modal onDismiss to run the pending action", () => {
    expect(indexSource).toMatch(/onDismiss=\{onDismissed\}/);
    expect(indexSource).toMatch(/onDismissed=\{handlePlusMenuDismissed\}/);
  });

  it("does not reintroduce iCloud entitlements the provisioning profile lacks", () => {
    // Build #48 failed iOS code signing because app.json requested iCloud
    // entitlements that the App Store provisioning profile does not carry.
    // The Files picker runs out-of-process and needs no iCloud entitlement,
    // so these config keys must stay out of app.json.
    const appConfig = JSON.parse(readFileSync(join(root, "app.json"), "utf8")) as {
      expo: { ios?: Record<string, unknown>; plugins?: unknown[] };
    };
    expect(appConfig.expo.ios?.usesIcloudStorage).toBeUndefined();
    const hasPickerPlugin = (appConfig.expo.plugins ?? []).some(
      (p) => p === "expo-document-picker" || (Array.isArray(p) && p[0] === "expo-document-picker"),
    );
    expect(hasPickerPlugin).toBe(false);
  });

  it("keeps expo-document-picker as a direct dependency", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["expo-document-picker"]).toBeTruthy();
  });
});
