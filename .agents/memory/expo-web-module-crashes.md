---
name: Expo web module crashes
description: How to handle native-only Expo SDK modules that crash on web due to missing transitive dependencies or unsupported native bindings.
---

## Problem

Top-level `import * as X from "expo-foo"` of a native-only Expo SDK module (e.g. `expo-sensors`, `expo-local-authentication`) in a web bundle can cause a runtime crash. The module itself may have a `.web.ts` shim, but its transitive dependencies (e.g. the npm `invariant` package) may not be present in the web node_modules resolution path, or its native binding may throw during initial evaluation.

## Symptom

React ErrorBoundary catches an error, but `error.message` may be cryptic or empty (`{}`). Browser console shows a blank screen or repeated render attempts. The crash happens during module import (before any of your code runs), so platform checks like `if (Platform.OS === "web")` at the top of the file do NOT help.

## Fix pattern

Replace the static top-level import with a lazy loader guarded by the actual execution path:

```ts
// BEFORE (crashes on web):
import * as LocalAuthentication from "expo-local-authentication";

useEffect(() => {
  if (Platform.OS === "web") return;
  LocalAuthentication.hasHardwareAsync()...
}, []);

// AFTER (safe on web):
async function getLocalAuth() {
  const LocalAuthentication = await import("expo-local-authentication");
  return LocalAuthentication;
}

useEffect(() => {
  if (Platform.OS === "web") return;
  void (async () => {
    try {
      const LocalAuthentication = await getLocalAuth();
      const has = await LocalAuthentication.hasHardwareAsync();
      // ...
    } catch {
      // ignore
    }
  })();
}, []);
```

## Why this works

Metro's tree-shaking and lazy bundling for web (`lazy=true` in the bundle URL) means `await import("...")` is treated as a dynamic chunk. If the module is never `await import()`ed on web (because of the `Platform.OS === "web"` guard), the chunk is never fetched or evaluated, so the missing transitive dependency is never encountered.

## Affected modules in this project

- `expo-local-authentication` — depends on npm `invariant`, which was missing from the web node_modules path (only present in pnpm store, symlinked for native).
- `expo-sensors` (Magnetometer) — native-only, no web support; already fixed with the same pattern in `camera.tsx`.

## Key rule

**Never rely on `Platform.OS` checks at module level to prevent a web crash.** Use dynamic `await import()` inside the actual guarded execution path instead.
