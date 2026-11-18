# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

First public release.

- Drop-in CLI for `electron-builder`. Reads your existing config and only appends `files` exclusions and size settings.
- Dependency analysis that keeps only what the app code actually loads (`analyze`, `pruneFiles`).
- Post-build smoke check, and one retry with a fresh tool cache when electron-builder fails.
- `packagerIgnore()` for `@electron/packager` / electron-forge.
- `plan`, `report` and `smoke` commands.
- Works when `--config <file>` and `-c.x=y` are combined, with older `app-builder-lib` config loader paths, and with pnpm's symlinked `node_modules`.

[Unreleased]: https://github.com/bcong/electron-build-slim/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bcong/electron-build-slim/releases/tag/v0.1.0
