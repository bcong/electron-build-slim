# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Project site redesigned, and the README, site and agent skill now state up front that savings depend on the project: the tool removes unused leftovers and does not optimize files the app needs.

## [0.1.0] - 2026-11-18

First public release, verified on 10 open-source Electron apps (see `benchmarks/`).

### Added

- Drop-in CLI for `electron-builder`. Reads your existing config and only appends `files` exclusions and size settings.
- Dependency analysis that keeps only what the app code actually loads (`analyze`, `pruneFiles`).
- Post-build smoke check, and one retry with a fresh tool cache when electron-builder fails.
- `packagerIgnore()` for `@electron/packager` / electron-forge.
- `plan`, `report` and `smoke` commands.
- Works when `--config <file>` and `-c.x=y` are combined, with older `app-builder-lib` config loader paths, and with pnpm's symlinked `node_modules`.
- `productionPackages()` export.
- A note when electron-builder is older than 26, which can still ship nested copies of dropped packages.
- Benchmark harness, results and a GitHub Pages site.

### Fixed during pre-release benchmarking

- `--slim-strip-webgpu` failed on electron-builder 24 because it used the `afterExtract` hook (added in 25). It now chains `afterPack`.
- Config validation errors no longer clear the tool cache and retry.
- The smoke check no longer fails on packages a regular build does not ship either (such as peers that are only devDependencies).
- electron-vite apps whose renderer uses `nodeIntegration` lost packages loaded with `window.require()` (LosslessCut opened to a black window). Explicit `require("…")` calls in `out/renderer` are now kept.
- The smoke check started the GUI and timed out on apps that disable the `RunAsNode` fuse. It now runs a temporary copy with that fuse on.
- Two-package.json apps (`directories.app`, e.g. Hyper with `target/`) were analyzed against the root `package.json`, so packages the app needs were dropped and the app crashed with `Cannot find module 'lodash'`. The app folder electron-builder packages is now analyzed and smoke-checked.
- The exclusions now go in a temporary config that `extends` the user's config, so they always come after the user's `files` patterns. Before, a `files` list ending in a `{from, to}` object (Mattermost) let later include patterns bring the excluded files back.
- `--slim-languages` is skipped with a note on electron-builder < 24, which has no `electronLanguages` option.
- electron-builder < 24 ships `asar` instead of `@electron/asar`; both are supported.
- pnpm's default isolated layout: `app-builder-lib` and `@electron/asar` are now found through electron-builder's real folder, and exclusion paths no longer carry the `.pnpm/<id>/node_modules/` prefix (so they actually match).
- A failed electron-builder run could exit with code 0 because `async-exit-hook` overwrote the exit code, so the cache retry never ran.

[Unreleased]: https://github.com/bcong/electron-build-slim/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bcong/electron-build-slim/releases/tag/v0.1.0
