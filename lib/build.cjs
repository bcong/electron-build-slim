// Packages with electron-builder. If that fails, clears the Electron/electron-builder download caches and retries once.
// On success, smoke-checks every output this machine can run (same OS/architecture).
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hostArch, hostPlatform, productionPackages } = require("../index.cjs");
const { smoke } = require("./smoke.cjs");
const { requireFromProject } = require("./project-require.cjs");

const log = (message) => console.log(`[slim] ${message}`);

// Defaults match what @electron/get and electron-builder use. CI pins them with environment variables to cache them.
const cacheDirs = () => {
    const home = os.homedir();
    const base =
        process.platform === "win32"
            ? (process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"))
            : process.platform === "darwin"
              ? path.join(home, "Library", "Caches")
              : (process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"));
    const sub = (name) => (process.platform === "win32" ? path.join(name, "Cache") : name);
    return {
        ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? path.join(base, sub("electron")),
        ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? path.join(base, sub("electron-builder")),
    };
};

// Root dependencies that actually ended up in the output (what the smoke check loads).
const packagedRootDependencies = (root, appDir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
    const asarFile = path.join(appDir, "resources", "app.asar");
    // Some tools (@electron/packager) leave empty folders behind, so a package counts only if its package.json is there.
    if (!fs.existsSync(asarFile))
        return names.filter((name) =>
            fs.existsSync(path.join(appDir, "resources", "app", "node_modules", name, "package.json")),
        );
    const asar = requireFromProject(root, "@electron/asar");
    const modules = asar.getRawHeader(asarFile).header.files.node_modules;
    return names.filter(
        (name) => name.split("/").reduce((node, part) => node?.files?.[part], modules)?.files?.["package.json"] != null,
    );
};

// win-unpacked, win-arm64-unpacked, linux-unpacked, linux-arm64-unpacked ... created by this build.
const unpackedDirs = (outDir, since) =>
    fs.existsSync(outDir)
        ? fs
              .readdirSync(outDir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && /-unpacked$/.test(entry.name))
              .map((entry) => path.join(outDir, entry.name))
              .filter((dir) => fs.statSync(dir).mtimeMs >= since - 1000)
        : [];
const unpackedArch = (dir) => /-(arm64|armv7l|ia32|x64)-unpacked$/.exec(path.basename(dir))?.[1] ?? "x64";

/**
 * @param {object} options
 * @param {string} [options.root] Project folder
 * @param {string[]} [options.builderArgs] Arguments passed through to electron-builder
 * @param {boolean} [options.smokeCheck] Whether to smoke-check the output
 * @param {{ level: string, languages?: string[], stripWebgpu?: boolean, keep?: string[], entries?: string[] }} options.slim
 * @returns {number} Exit code
 */
const build = ({ root = process.cwd(), builderArgs = [], smokeCheck = true, slim }) => {
    const caches = cacheDirs();
    const runner = path.join(__dirname, "run-builder.cjs");
    const infoFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slim-")), "info.json");
    const args = [
        ...(builderArgs.some((arg) => arg.startsWith("--publish") || arg === "-p") ? [] : ["--publish", "never"]),
        ...builderArgs,
    ];
    const startedAt = Date.now();

    const run = (attempt) => {
        const begin = Date.now();
        log(`attempt ${attempt}: electron-builder ${args.join(" ")}`);
        const { status } = spawnSync(process.execPath, [runner, JSON.stringify(slim), ...args], {
            cwd: root,
            stdio: "inherit",
            env: { ...process.env, ...caches, SLIM_INFO_FILE: infoFile },
        });
        log(
            `attempt ${attempt} ${status === 0 ? "succeeded" : `failed (exit ${status})`} in ${((Date.now() - begin) / 1000).toFixed(1)}s`,
        );
        return status;
    };

    const first = run(1);
    if (first === 2) {
        log("Failed while reading the config or analyzing dependencies. This is not a cache problem, so not retrying.");
        return 2;
    }
    if (first !== 0) {
        log(
            `The tool cache may be corrupted. Clearing it and downloading again:\n  ${Object.values(caches).join("\n  ")}`,
        );
        for (const dir of Object.values(caches)) fs.rmSync(dir, { recursive: true, force: true });
        // Tell CI the cache was refreshed so it saves it again.
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "tool-cache-refreshed=true\n");
        const second = run(2);
        if (second !== 0) return second;
    }

    const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    fs.rmSync(path.dirname(infoFile), { recursive: true, force: true });
    const out = path.resolve(root, info.outDir);
    for (const name of fs.existsSync(out) ? fs.readdirSync(out) : []) {
        if (!/\.(exe|msi|AppImage|snap|deb|rpm|dmg|pkg|zip|7z|tar\.[a-z]+)$/.test(name)) continue;
        const { size, mtimeMs } = fs.statSync(path.join(out, name));
        if (mtimeMs >= startedAt) log(`artifact ${name}: ${(size / 1048576).toFixed(1)} MB`);
    }

    if (!smokeCheck) return 0;
    const runnable = unpackedDirs(out, startedAt).filter(
        (dir) => info.targets[hostPlatform()] != null && unpackedArch(dir) === hostArch() && hostPlatform() !== "mac",
    );
    if (runnable.length === 0) {
        log(`smoke check skipped: nothing this machine (${hostPlatform()}/${hostArch()}) can run`);
        return 0;
    }
    let failed = false;
    for (const appDir of runnable) {
        const result = smoke({
            appDir,
            packages: packagedRootDependencies(root, appDir),
            shipped: productionPackages(root),
        });
        log(
            `smoke check ${path.basename(appDir)}: ${result.ok.length} ok, ${result.failed.length} failed, ${result.warnings.length} warnings`,
        );
        for (const line of result.warnings) log(`  warning ${line}`);
        for (const line of result.failed) log(`  failed  ${line}`);
        failed ||= result.failed.length > 0;
    }
    return failed ? 1 : 0;
};

module.exports = { build, cacheDirs, packagedRootDependencies };
