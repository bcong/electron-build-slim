// Runs electron-builder with the user's own config untouched, adding only size-related settings on top.
// Usage: node run-builder.cjs <options JSON> <electron-builder args...>   (called by bin/electron-build-slim.cjs)
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyze, targetsFromArgv } = require("../index.cjs");
const { requireFromProject: fromProject } = require("./project-require.cjs");

const PLATFORM_KEYS = { win: "win", linux: "linux", mac: "mac" };
// Formats decompressed on every launch. Their compression affects startup speed, so it is never changed.
const RUNTIME_DECOMPRESSED = /^(appimage|snap)$/i;
// Shader compilers used only by WebGPU (Dawn D3D12) on Windows. ANGLE (D3D11) uses d3dcompiler_47.dll.
const WEBGPU_ONLY_FILES = ["dxcompiler.dll", "dxil.dll"];

// Temporary folders created for this run, removed on exit.
const tempDirs = [];
const makeTempDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
};
process.on("exit", () => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const loadFirst = (root, ids, exportName) =>
    ids
        .map((id) => {
            try {
                return fromProject(root, id);
            } catch {
                return {};
            }
        })
        .find((mod) => typeof mod[exportName] === "function") ?? {};

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
const buildAdditions = ({ root, appDir, builderVersion, userConfig, targets, options }) => {
    // In a two-package.json layout (directories.app, or an app/ folder) the app folder's package.json and node_modules are packaged.
    const analysis = analyze({ root: appDir, targets, keep: options.keep, entries: options.entries });
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

    if (options.languages?.length) {
        if (builderVersion < 24)
            console.log(
                `[slim] --slim-languages skipped: electron-builder ${builderVersion} has no electronLanguages option.`,
            );
        else additions.electronLanguages = options.languages;
    }
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

// The file that holds the user's config. A "build" key in package.json is copied to a temporary JSON file. null if none.
const userConfigFile = async (root, configPath) => {
    const { getConfig } = loadFirst(root, ["app-builder-lib/out/util/config/load", "read-config-file"], "getConfig");
    if (getConfig == null) return configPath ? path.resolve(root, configPath) : null;
    const found = await getConfig(
        { packageKey: "build", configFilename: "electron-builder", projectDir: root },
        configPath,
    );
    if (found == null) return null;
    if (found.configFile != null) return path.resolve(root, found.configFile);
    const file = path.join(makeTempDir("slim-user-"), "package-build.json");
    fs.writeFileSync(file, JSON.stringify(found.result));
    return file;
};

// Exit codes: 0 success, 1 electron-builder failed (may be the cache, so it is retried), 2 this tool failed while preparing.
let stage = "prepare";

const main = async () => {
    const root = process.cwd();
    const [optionsJson, ...builderArgs] = process.argv.slice(2);
    const options = JSON.parse(optionsJson);
    const builder = fromProject(root, "electron-builder/out/builder");
    const builderVersion = Number(fromProject(root, "electron-builder/package.json").version.split(".")[0]);
    // The config loader lives in slightly different places across electron-builder versions.
    const { getConfig, computeDefaultAppDirectory } = loadFirst(
        root,
        ["app-builder-lib/out/util/config/config", "app-builder-lib/out/util/config"],
        "getConfig",
    );
    if (getConfig == null)
        throw new Error("Could not find the config loader (getConfig) in this electron-builder version.");

    const argv = builder.configureBuildCommand(builder.createYargs()).parse(builderArgs);
    // With both --config <file> and -c.x=y, yargs passes `config` as an array.
    const configItems = [argv.config ?? []].flat();
    const configPath = configItems.find((item) => typeof item === "string") ?? null;
    const cliOverrides = Object.assign({}, ...configItems.filter((item) => item != null && typeof item === "object"));
    // Read-only: used to look at the existing compression, output folder, app folder, targets and hooks.
    const userConfig = await getConfig(root, configPath, structuredClone(cliOverrides));
    const appDir =
        typeof computeDefaultAppDirectory === "function"
            ? await computeDefaultAppDirectory(root, userConfig.directories?.app)
            : root;
    const targets = targetsFromArgv(builderArgs);
    const { additions, analysis } = buildAdditions({ root, appDir, builderVersion, userConfig, targets, options });

    console.log(
        `[slim] targets ${Object.entries(targets)
            .map(([p, a]) => `${p}/${a.join(",")}`)
            .join(
                " ",
            )}, level ${options.level}${appDir === root ? "" : `, app folder ${path.relative(root, appDir)}`}: ` +
            `keeping ${analysis.keep.length} dependencies, dropping ${analysis.drop.length}` +
            (analysis.undeclared.length ? ` (including undeclared: ${analysis.undeclared.join(", ")})` : ""),
    );
    if (process.env.SLIM_INFO_FILE) {
        fs.writeFileSync(
            process.env.SLIM_INFO_FILE,
            JSON.stringify({ outDir: userConfig.directories?.output ?? "dist", targets, appDir }),
        );
    }
    if (builderVersion < 26) {
        console.log(
            `[slim] electron-builder ${builderVersion} detected: nested copies of dropped packages (node_modules/<dropped>/node_modules/*) may still be shipped. Use electron-builder 26+ for full savings.`,
        );
    }

    // The exclusions go in a temporary config file whose parent (`extends`) is the user's config. electron-builder joins a
    // file set's filters parent first, so they come after the user's patterns. Merging them into the same config instead
    // can put them before the user's patterns (e.g. when `files` ends with a {from, to} object), and a later include such
    // as node_modules/x/**/* would bring the excluded files back. An `extends` containing "." is used as the config path.
    const { files, ...rest } = additions;
    const userFile = await userConfigFile(root, configPath);
    const slimFile = path.join(makeTempDir("slim-config-"), "electron-builder.slim.json");
    fs.writeFileSync(slimFile, JSON.stringify({ ...(userFile ? { extends: userFile } : {}), files }));
    const config = { ...cliOverrides, ...rest, extends: slimFile };
    for (const key of Object.values(PLATFORM_KEYS)) {
        if (cliOverrides[key] && additions[key]) config[key] = { ...cliOverrides[key], ...additions[key] };
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
