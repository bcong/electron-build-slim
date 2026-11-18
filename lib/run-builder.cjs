// Runs electron-builder with the user's own config untouched, adding only size-related settings on top.
// electron-builder deep-merges the config object we pass with the config on disk, and appends arrays (such as `files`).
// Usage: node run-builder.cjs <options JSON> <electron-builder args...>   (called by bin/electron-build-slim.cjs)
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { analyze, targetsFromArgv } = require("../index.cjs");

const PLATFORM_KEYS = { win: "win", linux: "linux", mac: "mac" };
// Formats decompressed on every launch. Their compression affects startup speed, so it is never changed.
const RUNTIME_DECOMPRESSED = /^(appimage|snap)$/i;
// Shader compilers used only by WebGPU (Dawn D3D12) on Windows. ANGLE (D3D11) uses d3dcompiler_47.dll.
const WEBGPU_ONLY_FILES = ["dxcompiler.dll", "dxil.dll"];

const { requireFromProject: fromProject } = require("./project-require.cjs");

const targetNames = (config, platform) =>
    [config[PLATFORM_KEYS[platform]]?.target ?? []]
        .flat()
        .map((target) => (typeof target === "string" ? target : (target?.target ?? "")));

// Wraps the user's hook (function or module path) and runs it first.
const chainHook = (root, userHook, ours) => async (context) => {
    if (typeof userHook === "function") await userHook(context);
    else if (typeof userHook === "string") {
        const loaded = require(path.resolve(root, userHook));
        await (typeof loaded === "function" ? loaded : loaded.default)(context);
    }
    await ours(context);
};

/**
 * @param {{ level: "safe" | "standard" | "max", languages?: string[], stripWebgpu?: boolean, keep?: string[], entries?: string[] }} options
 */
const buildAdditions = ({ root, userConfig, targets, options }) => {
    const analysis = analyze({ root, targets, keep: options.keep, entries: options.entries });
    const additions = { files: analysis.files };

    const compression = userConfig.compression ?? "normal";
    if (options.level === "max") {
        additions.compression = "maximum";
    } else if (options.level === "standard" && compression === "store") {
        additions.compression = "normal";
    }
    // `maximum` makes AppImage use xz on Linux, which slows down every launch, so that platform keeps its original value.
    if (additions.compression) {
        for (const platform of Object.keys(targets)) {
            const key = PLATFORM_KEYS[platform];
            const runtimeDecompressed =
                platform === "linux" &&
                (targetNames(userConfig, platform).length === 0 ||
                    targetNames(userConfig, platform).some((name) => RUNTIME_DECOMPRESSED.test(name)));
            if (runtimeDecompressed && userConfig[key]?.compression === undefined) {
                additions[key] = { ...additions[key], compression: compression === "store" ? "normal" : compression };
            }
        }
    }

    if (options.languages?.length) additions.electronLanguages = options.languages;
    if (options.stripWebgpu) {
        // afterExtract only exists since electron-builder 25; afterPack exists in every version and runs before signing/installers.
        additions.afterPack = chainHook(root, userConfig.afterPack, async ({ appOutDir, electronPlatformName }) => {
            if (electronPlatformName !== "win32") return;
            for (const name of WEBGPU_ONLY_FILES) fs.rmSync(path.join(appOutDir, name), { force: true });
        });
    }
    // electron-builder 26 ignores ELECTRON_CACHE, so the Electron zip cache location is passed explicitly.
    if (process.env.ELECTRON_CACHE && userConfig.electronDownload?.cache == null) {
        additions.electronDownload = { cache: process.env.ELECTRON_CACHE };
    }
    return { additions, analysis };
};

// Exit codes: 0 success, 1 electron-builder failed (may be the cache, so it is retried), 2 this tool failed while preparing.
let stage = "prepare";

const main = async () => {
    const root = process.cwd();
    const [optionsJson, ...builderArgs] = process.argv.slice(2);
    const options = JSON.parse(optionsJson);
    const builder = fromProject(root, "electron-builder/out/builder");
    // The config loader lives in slightly different places across electron-builder versions.
    const { getConfig } =
        ["app-builder-lib/out/util/config/config", "app-builder-lib/out/util/config"]
            .map((id) => {
                try {
                    return fromProject(root, id);
                } catch {
                    return {};
                }
            })
            .find((mod) => typeof mod.getConfig === "function") ?? {};
    if (getConfig == null)
        throw new Error("Could not find the config loader (getConfig) in this electron-builder version.");

    const argv = builder.configureBuildCommand(builder.createYargs()).parse(builderArgs);
    // With both --config <file> and -c.x=y, yargs passes `config` as an array.
    const configItems = [argv.config ?? []].flat();
    const configPath = configItems.find((item) => typeof item === "string") ?? null;
    const cliOverrides = Object.assign({}, ...configItems.filter((item) => item != null && typeof item === "object"));
    // Read-only: used only to look at the existing compression, output folder, targets and hooks.
    const userConfig = await getConfig(root, configPath, structuredClone(cliOverrides));
    const targets = targetsFromArgv(builderArgs);
    const { additions, analysis } = buildAdditions({ root, userConfig, targets, options });

    console.log(
        `[slim] targets ${Object.entries(targets)
            .map(([p, a]) => `${p}/${a.join(",")}`)
            .join(" ")}, level ${options.level}: ` +
            `keeping ${analysis.keep.length} dependencies, dropping ${analysis.drop.length}` +
            (analysis.undeclared.length ? ` (including undeclared: ${analysis.undeclared.join(", ")})` : ""),
    );
    if (process.env.SLIM_INFO_FILE) {
        fs.writeFileSync(
            process.env.SLIM_INFO_FILE,
            JSON.stringify({ outDir: userConfig.directories?.output ?? "dist", targets }),
        );
    }

    // If a config file was given, load it through `extends` (electron-builder treats an `extends` containing "." as the config path).
    const config = { ...cliOverrides, ...additions, ...(configPath ? { extends: configPath } : {}) };
    for (const key of Object.values(PLATFORM_KEYS)) {
        if (cliOverrides[key] && additions[key]) config[key] = { ...cliOverrides[key], ...additions[key] };
    }
    const builderVersion = Number(fromProject(root, "electron-builder/package.json").version.split(".")[0]);
    if (builderVersion < 26) {
        console.log(
            `[slim] electron-builder ${builderVersion} detected: nested copies of dropped packages (node_modules/<dropped>/node_modules/*) may still be shipped. Use electron-builder 26+ for full savings.`,
        );
    }
    stage = "build";
    await builder.build({ ...argv, config });
};

main().catch((error) => {
    console.error(error);
    // Config validation errors are not cache problems, so they are not retried.
    const code = stage === "build" && error?.name !== "ValidationError" ? 1 : 2;
    process.exitCode = code;
    // async-exit-hook (used by electron-builder's temp-file) calls process.exit(0) on beforeExit and overwrites the exit code.
    // Pin it again on exit, like the electron-builder CLI does (electron-builder#2940).
    process.on("exit", () => (process.exitCode = code));
});
