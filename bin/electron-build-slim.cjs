#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { analyze, targetsFromArgv } = require("../index.cjs");

const USAGE = `electron-build-slim: use it instead of electron-builder to build a smaller app with your existing config.

  electron-build-slim [electron-builder args...] [--slim-* options]
      e.g. electron-build-slim --win --x64
           electron-build-slim --linux AppImage --arm64 --slim-level max

  --slim-level <safe|standard|max>  default: standard
        safe      drop only dependencies/files the app never loads
        standard  safe + installer compression store -> normal (installer only, no runtime effect)
        max       standard + maximum installer compression (never for AppImage/snap, which decompress at launch)
  --slim-languages <en-US,ko>       keep only these Chromium UI locales (default: keep all)
  --slim-strip-webgpu               remove Windows WebGPU-only DLLs (dxcompiler, dxil); only if the app does not use WebGPU
  --slim-keep <a,b>                 always ship these dependencies (e.g. dynamic require)
  --slim-entries <dir,dir>          where the app code lives (default: out/main+out/preload, else the whole project)
  --slim-no-smoke                   skip the post-build smoke check

  electron-build-slim plan [target args] [--slim-keep a,b]   preview what is kept and dropped
  electron-build-slim report <app.asar> [count]               size of app.asar per package
  electron-build-slim smoke <win-unpacked etc.> [packages...] run only the smoke check

  Other electron-builder commands (install-app-deps, ...) are passed through to electron-builder.`;

const BUILDER_COMMANDS = new Set([
    "install-app-deps",
    "node-gyp-rebuild",
    "create-self-signed-cert",
    "start",
    "publish",
]);
const LEVELS = new Set(["safe", "standard", "max"]);

// Splits off --slim-* options; everything else goes to electron-builder.
const splitArgs = (args) => {
    const slim = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
        const match = /^--slim-([a-z-]+)(?:=(.*))?$/.exec(args[i]);
        if (!match) {
            rest.push(args[i]);
            continue;
        }
        const [, key, inline] = match;
        const flag = key === "strip-webgpu" || key === "no-smoke";
        slim[key] = flag ? true : (inline ?? args[++i]);
    }
    return { slim, rest };
};
const list = (value) =>
    value
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean);

const slimOptions = (slim) => {
    const level = slim.level ?? "standard";
    if (!LEVELS.has(level)) throw new Error(`--slim-level must be safe, standard or max: ${level}`);
    return {
        level,
        languages: list(slim.languages),
        stripWebgpu: slim["strip-webgpu"] === true,
        keep: list(slim.keep),
        entries: list(slim.entries),
    };
};

const [command, ...others] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
} else if (BUILDER_COMMANDS.has(command)) {
    const cli = require.resolve("electron-builder/cli.js", { paths: [process.cwd()] });
    process.exitCode = spawnSync(process.execPath, [cli, command, ...others], { stdio: "inherit" }).status ?? 1;
} else if (command === "plan") {
    const { slim, rest } = splitArgs(others);
    const result = analyze({ targets: targetsFromArgv(rest), keep: list(slim.keep), entries: list(slim.entries) });
    console.log(`app code: ${result.entryDirs.join(", ")}`);
    console.log(`used by the app (${result.entries.length}): ${result.entries.join(", ")}`);
    console.log(`required without being declared (${result.undeclared.length}): ${result.undeclared.join(", ")}`);
    console.log(`kept (${result.keep.length}): ${result.keep.join(", ")}`);
    console.log(`dropped (${result.drop.length}): ${result.drop.join(", ")}`);
    console.log(`source-only folders dropped (${result.sourceOnly.length}): ${result.sourceOnly.join(", ")}`);
    console.log(
        `prebuilds for other platforms dropped (${result.prebuilds.length})${result.prebuilds.length ? `\n  ${result.prebuilds.join("\n  ")}` : ""}`,
    );
} else if (command === "report") {
    const { asarSizes } = require("../lib/report.cjs");
    const [file, count = "30"] = others;
    if (!file) throw new Error(USAGE);
    const mb = (bytes) => (bytes / 1048576).toFixed(2).padStart(8);
    for (const row of asarSizes(file).slice(0, Number(count)))
        console.log(`${mb(row.packed + row.unpacked)} MB  (unpacked ${mb(row.unpacked)} MB)  ${row.name}`);
} else if (command === "smoke") {
    const { smoke } = require("../lib/smoke.cjs");
    const { packagedRootDependencies } = require("../lib/build.cjs");
    const [appDir, ...packages] = others;
    if (!appDir) throw new Error(USAGE);
    const names = packages.length > 0 ? packages : packagedRootDependencies(process.cwd(), path.resolve(appDir));
    const result = smoke({
        appDir,
        packages: names,
        shipped: require("../index.cjs").productionPackages(process.cwd()),
    });
    console.log(`${result.ok.length} ok, ${result.failed.length} failed, ${result.warnings.length} warnings`);
    for (const line of [...result.failed.map((l) => `failed  ${l}`), ...result.warnings.map((l) => `warning ${l}`)])
        console.log(`  ${line}`);
    process.exitCode = result.failed.length > 0 ? 1 : 0;
} else {
    const { build } = require("../lib/build.cjs");
    const args = command === "build" ? others : process.argv.slice(2);
    const { slim, rest } = splitArgs(args);
    process.exitCode = build({ builderArgs: rest, smokeCheck: slim["no-smoke"] !== true, slim: slimOptions(slim) });
}
