---
name: RN Modal vs native picker presentation race (iOS)
description: Why launching a native picker right after closing an RN Modal breaks on TestFlight, and why the Files picker never needs iCloud entitlements
---

## The Rule
Never launch a native iOS picker (Files, camera, photo library) — or open a second RN `<Modal>` — synchronously after setting an RN `<Modal>`'s visible to false. Defer the action to the Modal's `onDismiss` callback (iOS-only; fires after the dismissal animation). On Android run the action immediately, since `onDismiss` may not fire there.

**Why:** iOS cannot present a view controller while another is mid-dismissal. expo-document-picker sets its native `pickingContext` BEFORE calling `present()`; a silently failed presentation leaks that context, so every later `getDocumentAsync` call instantly throws `PickingInProgressException` ("Could not open the file picker") until app restart. Dev/Expo Go timing usually masks the race; it reproduces on real TestFlight builds.

**How to apply:** pending-action ref pattern — the menu action stores a callback in a ref and closes the menu; `Modal onDismiss` runs and clears the ref; clear the ref again whenever the menu opens so a stale action can't replay on a later backdrop close.

## Entitlement red herring
`UIDocumentPickerViewController` runs out-of-process and needs NO iCloud entitlement to browse Files/iCloud Drive. Adding `ios.usesIcloudStorage` + the expo-document-picker `iCloudContainerEnvironment` plugin config makes EAS iOS builds FAIL code signing ("provisioning profile doesn't support the iCloud capability") — the stored EAS provisioning profile lacks the capability, `--non-interactive` builds skip capability sync, and iCloud containers cannot be created through the public ASC API headlessly. Keep those keys out of app.json (regression-tested in the mobile document-picker wiring test).
