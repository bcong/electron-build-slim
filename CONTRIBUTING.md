# Contributing

Issues and pull requests are welcome.

## The rule

This tool only removes size **without changing startup speed or behavior**. When you propose a new pruning rule, include:

- Evidence that the files are never used at runtime (code, docs or an experiment).
- A build with the rule that passes the smoke check and actually launches.
- If the rule can affect behavior, make it an opt-in `--slim-*` flag, not a default.

## Development

```bash
git clone https://github.com/bcong/electron-build-slim.git
cd electron-build-slim
npm test
```

It is dependency-free Node.js (runtime: Node.js 20.12+, tests: Node.js 22+). `electron-builder` is loaded from the app that uses this tool.

To try it on a real app, run the local source from the app folder:

```bash
node /path/to/electron-build-slim/bin/electron-build-slim.cjs plan --win
node /path/to/electron-build-slim/bin/electron-build-slim.cjs --win --x64
```

## Pull requests

- One change per pull request.
- If you change behavior, add a test under `test/` and a line under `Unreleased` in `CHANGELOG.md`.
- Back size claims with measured numbers (bytes before and after, and how many runs).

## Releasing

Bump the version on `main` and publish a GitHub release named `vX.Y.Z`. The `publish` workflow publishes to npm with provenance through npm Trusted Publishing.
