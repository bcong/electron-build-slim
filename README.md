# electron-build-slim

[![npm](https://img.shields.io/npm/v/electron-build-slim.svg)](https://www.npmjs.com/package/electron-build-slim)
[![test](https://github.com/bcong/electron-build-slim/actions/workflows/test.yml/badge.svg)](https://github.com/bcong/electron-build-slim/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Ship smaller Electron apps without touching how they run.

`electron-build-slim` is a drop-in replacement for the `electron-builder` command. It keeps your existing config, packages only the `node_modules` your app actually loads, checks that the packaged app can still load them, and retries once with a fresh tool cache if the build fails. Anything that could change startup speed or behavior is opt-in.

```bash
npm i -D electron-build-slim
npx electron-build-slim --win          # instead of: electron-builder --win
```

## What it removes

| Removed | Default | Effect on runtime |
|---|---|---|
| Dependencies the app code never loads (the `electron` npm package, `node-gyp`, renderer-only libraries that were already bundled, ...) | on | none, verified by the post-build smoke check |
| Docs, tests, C/C++ sources and build leftovers inside dependencies | on | none |
| Native binaries for other platforms/architectures (`prebuilds/<os>-<arch>`) | on | none |
| Installer compression `store` → `normal` | on (`standard`) | none, the installer is unpacked once at install time |
| Chromium locales (`--slim-languages`) | off | the app's locale (`app.getLocale()`, `navigator.language`) falls back to a kept language, so apps that pick their language from it may start in another language |
| Windows WebGPU-only DLLs (`--slim-strip-webgpu`) | off | breaks WebGPU if the app uses it |

**Never done:** changing the compression of formats that decompress on every launch (AppImage, snap), turning off `asar`, UPX, or deleting Chromium runtime files such as swiftshader, `icudtl.dat` or `*.pak`.

How much you save depends on the app. Apps that accidentally ship large packages save a lot; apps with few dependencies barely change. A common cause is the `electron` npm package itself (about 340 MB unpacked on Windows) being shipped a second time because some dependency lists it as a peer dependency.

<!-- BENCHMARKS -->

## Install

```bash
npm i -D electron-build-slim
# or
yarn add -D electron-build-slim
# or
pnpm add -D electron-build-slim
```

Tested with Node.js 20.12+ and electron-builder 24 and 26. With electron-builder older than 26, nested copies of dropped packages (`node_modules/<dropped>/node_modules/*`) may still be shipped, so savings are smaller; the tool prints a note.

## Usage

### electron-builder (recommended)

Keep your config wherever it is (`build` in `package.json`, `electron-builder.yml`, `electron-builder.config.js`, ...). Only replace the command:

```json
{
    "scripts": {
        "dist:win": "electron-vite build && electron-build-slim --win",
        "dist:linux": "electron-vite build && electron-build-slim --linux AppImage --arm64"
    }
}
```

All electron-builder arguments pass through (`--config`, `--dir`, `--publish`, `-c.xxx=yyy`, ...). Without `--publish`, `--publish never` is added. Other electron-builder commands such as `install-app-deps` are forwarded as-is.

The tool never rewrites your config. It runs electron-builder with your config plus a few appended settings (`files` exclusions, compression). Your hooks (`afterPack`, ...) keep working.

### Options

| Option | Description |
|---|---|
| `--slim-level <safe\|standard\|max>` | Default `standard`. See below. |
| `--slim-languages en-US,ko` | Keep only these Chromium locales (electron-builder `electronLanguages`). This also changes `app.getLocale()` and `navigator.language` for users whose system language was removed. |
| `--slim-strip-webgpu` | Remove `dxcompiler.dll` and `dxil.dll` on Windows. Only if the app does not use WebGPU. |
| `--slim-keep a,b` | Always ship these dependencies, e.g. modules loaded with `require(someVariable)`. |
| `--slim-entries dir1,dir2` | Where the app code lives. Default: `out/main` + `out/preload` (electron-vite), otherwise the whole project except `node_modules`. |
| `--slim-no-smoke` | Skip the post-build smoke check. |

| Level | What it does |
|---|---|
| `safe` | Drops only dependencies and files the app never loads. Config otherwise untouched. |
| `standard` | `safe` + installer compression `store` → `normal`. |
| `max` | `standard` + `compression: maximum`. Linux keeps its original value because `maximum` turns AppImage into xz, which slows every launch. |

NSIS installers are packed with 7z, and electron-builder 26 uses the same 7z level (`-mx=9`) for `normal` and `maximum`. So for NSIS-only builds `max` and `standard` give practically the same size. `max` matters for formats such as zip.

### Post-build smoke check

After the build, the tool loads every root dependency that made it into the output inside the packaged Electron runtime (`ELECTRON_RUN_AS_NODE`). Errors that mean a file was removed (`Cannot find module`, `Could not locate the bindings file`, `No native build was found`) fail the build.

- `Cannot find module 'electron'` is only a warning, because `electron` is built in at real runtime.
- A missing package that a regular electron-builder build would not ship either (for example a peer dependency that is only a devDependency) is a warning, not a failure.
- Load errors of native modules for another OS (for example a Linux-only module on Windows) are warnings too.
- It runs only for outputs this machine can execute (same OS and architecture). macOS outputs are not checked yet.

### Tool cache and retry

If electron-builder fails, the tool clears the Electron zip cache and the electron-builder tool cache (NSIS, AppImage tools, ...), downloads them again and retries once. Failures while reading the config or analyzing dependencies are not cache problems and are not retried.

Set `ELECTRON_CACHE` and `ELECTRON_BUILDER_CACHE` to move the caches. electron-builder 26 ignores `ELECTRON_CACHE`, so the tool passes it as `electronDownload.cache` unless your config already sets one.

### Other commands

```bash
npx electron-build-slim plan --win --x64                               # preview what is kept and dropped
npx electron-build-slim report dist/win-unpacked/resources/app.asar    # size of app.asar per package
npx electron-build-slim smoke dist/win-unpacked                        # run only the smoke check
```

Run `report` before adopting the tool. If you see `node_modules/electron`, `node-gyp`, `tar`, or renderer libraries such as `react`, there is something to remove.

### @electron/packager and electron-forge

`packagerIgnore()` returns regexes for packager's `ignore` option. Passing an array keeps packager's default ignore rules (a function would replace them).

```js
// forge.config.js
const { packagerIgnore } = require("electron-build-slim");

module.exports = {
    packagerConfig: {
        asar: true,
        ignore: [/^\/out($|\/)/, ...packagerIgnore({ targets: { win: ["x64"] } })],
    },
};
```

- Without `targets`, the current OS and architecture are used.
- Verified with `@electron/packager` directly. Not yet verified inside an electron-forge project.
- Forge's Vite and Webpack plugins set `ignore` to their own function, so this does not apply there.
- Run the smoke check separately with `npx electron-build-slim smoke <packaged folder>`.

### API

```js
const { analyze, pruneFiles, packagerIgnore } = require("electron-build-slim");

analyze({ root, targets: { win: ["x64"] }, keep: [], entries: undefined, neverShip: [] });
// → { entries, undeclared, keep, drop, sourceOnly, prebuilds, files }

pruneFiles(); // exclusions to append to electron-builder `files` (targets read from CLI args)
```

If you would rather not change the command, use it in a JS electron-builder config:

```js
// electron-builder.config.js
const { pruneFiles } = require("electron-build-slim");
module.exports = { files: ["out/**/*", ...pruneFiles()] /* ...your config */ };
```

In that case there is no smoke check and no cache retry.

## Caching the tools in GitHub Actions

Save the cache only after a successful build. If the build had to clear and re-download the cache, the tool writes `tool-cache-refreshed=true` to the step output, so the stale entry is deleted and saved again.

```yaml
permissions:
  contents: read
  actions: write # to delete a corrupted cache entry

steps:
  - name: Set tool cache paths
    shell: bash
    run: |
      echo "TOOLS_CACHE_KEY=tools-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json', 'yarn.lock', 'pnpm-lock.yaml') }}" >> "$GITHUB_ENV"
      echo "ELECTRON_CACHE=$RUNNER_TEMP/electron-cache" >> "$GITHUB_ENV"
      echo "ELECTRON_BUILDER_CACHE=$RUNNER_TEMP/electron-builder-cache" >> "$GITHUB_ENV"

  - name: Restore build tool cache
    id: tools
    uses: actions/cache/restore@v4
    with:
      path: |
        ${{ env.ELECTRON_CACHE }}
        ${{ env.ELECTRON_BUILDER_CACHE }}
      key: ${{ env.TOOLS_CACHE_KEY }}
      restore-keys: tools-${{ runner.os }}-${{ runner.arch }}-

  - name: Build
    id: build
    run: npx electron-build-slim --linux AppImage

  - name: Drop stale build tool cache
    if: steps.tools.outputs.cache-hit == 'true' && steps.build.outputs.tool-cache-refreshed == 'true'
    env:
      GH_TOKEN: ${{ github.token }}
    run: gh cache delete "$TOOLS_CACHE_KEY" --repo "$GITHUB_REPOSITORY" || true

  - name: Save build tool cache
    if: steps.tools.outputs.cache-hit != 'true' || steps.build.outputs.tool-cache-refreshed == 'true'
    uses: actions/cache/save@v4
    with:
      path: |
        ${{ env.ELECTRON_CACHE }}
        ${{ env.ELECTRON_BUILDER_CACHE }}
      key: ${{ env.TOOLS_CACHE_KEY }}
```

## How it works

1. Find the root `dependencies` whose names appear in the app code. Module names survive as string constants even when the main process is compiled to V8 bytecode (`.jsc`).
2. Follow their `dependencies` and `optionalDependencies`. `peerDependencies` are not followed (that is how `electron` usually sneaks in). `@types/*` and build-only packages (`node-gyp`, `prebuild-install`, `nan`, `node-addon-api`, `patch-package`, ...) are skipped.
3. Add root dependencies that kept packages require without declaring them (common with patched packages). Repeat until nothing new is found.
4. Everything electron-builder could ship that is not in that set becomes a `files` exclusion.
5. Inside kept packages, drop `prebuilds` for other platforms, `src`/`deps` folders with no runtime files, and docs, tests and C/C++ sources.

## Limitations

- **The analysis is string-based.** Modules loaded through a computed name are not found; add them with `--slim-keep`. The smoke check only catches files missing when a package is first loaded; code paths loaded later need a real run of the app.
- **Unbundled apps** (packaged straight from sources) are scanned as a whole, so renderer-only dependencies may stay. It errs on the side of keeping.
- **The renderer is only checked for explicit `require("…")` calls** (in electron-vite's `out/renderer`). Other ways of loading node modules from a `nodeIntegration` renderer need `--slim-keep`.
- **Package managers:** verified with npm and yarn (`node_modules` linker). Yarn PnP is not supported.
- **macOS:** analysis and exclusions are the same, but builds and smoke checks have not been verified on macOS.

## License

[MIT](LICENSE). You are free to use, fork, modify and redistribute it, including for commercial use. Just keep the license notice.
