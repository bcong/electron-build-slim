---
name: electron-build-slim
description: Use when shrinking an Electron app's installer or AppImage without changing startup speed or behavior. Applies to requests like "the installer is too big", "win-unpacked/linux-unpacked is huge", "node_modules is shipped whole", "the electron-builder tool cache keeps breaking", or CI build caching.
---

# Shrinking an Electron build

The tool is the npm package `electron-build-slim` (see its README). Work in this order, and keep the numbers and output of each step as evidence.

## 1. Measure the baseline

1. Build once with the current setup. Record the installer size in bytes, the size of `*-unpacked`, and the packaging time.
2. Run `npx electron-build-slim report <unpacked>/resources/app.asar 30` to see what takes the space. Names like `node_modules/electron`, `node-gyp`, `tar`, or renderer-only `react` mean there is something to remove.
3. Sizes are deterministic, so one build is enough. If you time it once, say it was one run.

## 2. Apply

1. `npm i -D electron-build-slim`, then replace `electron-builder` with `electron-build-slim` in the build script. Leave the existing config alone.
2. Run `npx electron-build-slim plan --win` (or `--linux --arm64`) to see what is kept and dropped. If a package the app uses is in "dropped", find out why. If it is required through a computed name, add it to `--slim-keep`.
3. Start with the default level (`standard`). Removing locales (`--slim-languages`) and WebGPU DLLs (`--slim-strip-webgpu`) can affect behavior, so turn them on only when the user confirms.

## 3. Verify the output

A green build is not enough.

1. Read the smoke check at the end of the build. Fix every "failed" line. Among warnings, `Cannot find module 'electron'` and load errors of other-OS-only native modules are expected. Compare with the regular build using the `smoke` command.
2. Launch the packaged app and check the first screen. Using `--remote-debugging-port` and CDP to save the title, text and a screenshot makes the check repeatable.
3. Before launching, check whether the app changes the system at startup (auto-start registration, service install) and turn that off.
4. Measure size and time the same way as the baseline and put them side by side.

## 4. Verify the cache retry

Point `ELECTRON_CACHE` and `ELECTRON_BUILDER_CACHE` at temporary folders so the user's real cache is untouched.

1. Build with empty caches. The Electron zip and the NSIS/AppImage tools should appear in them.
2. Overwrite an extracted tool (for example `nsis-*/Bin/makensis.exe`) with junk bytes and build. Expect attempt 1 to fail, the cache to be cleared, and attempt 2 to succeed.
3. A corrupted Electron zip is re-downloaded by its checksum check, so it cannot be used to test the retry path.

## Don't

- Change AppImage or snap compression to xz or similar. They decompress on every launch, which slows startup a lot on slow devices such as a Raspberry Pi.
- Delete `vk_swiftshader*`, `libEGL`, `libGLESv2`, `icudtl.dat`, `*.pak`, `snapshot_blob.bin`, `v8_context_snapshot.bin` or `ffmpeg`.
- Delete `LICENSES.chromium.html`. It is the Chromium license notice.
- Use UPX or `asar: false`.
- Widen the pruning rules without checking. If you do, run the smoke check and launch the app again.
