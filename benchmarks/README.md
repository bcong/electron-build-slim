# Benchmarks

Each app is built twice from the same checkout with the same arguments:

1. **base**: the app's own `electron-builder` (`--win nsis --x64 --publish never`).
2. **slim**: `electron-build-slim` with the default level (`standard`) and the same arguments.
3. **slim + opt-ins** (separate run): `--slim-languages en-US --slim-strip-webgpu` on top.

For every output the harness records:

- installer size in bytes, size of `win-unpacked`, and the largest packages inside `app.asar`;
- the smoke check (each root dependency that made it into the output is `require`d inside the packaged Electron runtime);
- a real launch with `--remote-debugging-port`: time to the first window, page titles, amount of visible text, a screenshot, and whether the app is still alive after waiting.

Builds ran in parallel on one Windows 11 x64 machine (32 cores) with per-app Electron and electron-builder caches. Sizes are deterministic, so each variant was built once. Times are single runs and only indicative.

## Reproduce

```bash
git clone --depth 1 --branch <tag> <app repo> app && cd app
# install dependencies and run the app's compile/bundle step (not its packaging step)
node /path/to/electron-build-slim/benchmarks/bench.cjs --app . --name <id> --args "--win nsis --x64" --wait 15
node /path/to/electron-build-slim/benchmarks/bench.cjs --app . --name <id>-opts --skip-base --args "--win nsis --x64" \
  --slim-args "--slim-languages en-US --slim-strip-webgpu" --wait 15
```

Results land in `benchmarks/results/<id>/result.json` with `base.png` and `slim.png` screenshots.

App names and trademarks belong to their owners. These apps were built from their public source code for measurement only; this project is not affiliated with them.
