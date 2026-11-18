// electron-builder로 패키징하고, 실패하면 Electron/electron-builder 다운로드 캐시를 비우고 다시 받아 한 번 재시도한다.
// 성공하면 이 PC에서 실행할 수 있는 결과물(같은 OS/아키텍처)에 스모크 검사를 돌린다.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hostArch, hostPlatform } = require("../index.cjs");
const { smoke } = require("./smoke.cjs");

const log = (message) => console.log(`[slim] ${message}`);

// 기본 위치는 @electron/get, electron-builder가 쓰는 곳과 같다. CI는 환경 변수로 경로를 고정해 캐시한다.
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

// 결과물에 실제로 들어간 루트 dependencies (스모크 검사 대상).
const packagedRootDependencies = (root, appDir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
    const asarFile = path.join(appDir, "resources", "app.asar");
    // 빈 폴더만 남기는 도구(@electron/packager)가 있어서 package.json이 있어야 들어간 것으로 본다.
    if (!fs.existsSync(asarFile))
        return names.filter((name) =>
            fs.existsSync(path.join(appDir, "resources", "app", "node_modules", name, "package.json")),
        );
    const asar = require(require.resolve("@electron/asar", { paths: [root] }));
    const modules = asar.getRawHeader(asarFile).header.files.node_modules;
    return names.filter(
        (name) => name.split("/").reduce((node, part) => node?.files?.[part], modules)?.files?.["package.json"] != null,
    );
};

// win-unpacked, win-arm64-unpacked, linux-unpacked, linux-arm64-unpacked ... 중 이번 빌드에서 만든 것.
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
 * @param {string} [options.root] 프로젝트 폴더
 * @param {string[]} [options.builderArgs] electron-builder에 그대로 넘길 인자
 * @param {boolean} [options.smokeCheck] 빌드 후 스모크 검사 여부
 * @param {{ level: string, languages?: string[], stripWebgpu?: boolean, keep?: string[], entries?: string[] }} options.slim
 * @returns {number} 종료 코드
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
        log(`${attempt}차 시도: electron-builder ${args.join(" ")}`);
        const { status } = spawnSync(process.execPath, [runner, JSON.stringify(slim), ...args], {
            cwd: root,
            stdio: "inherit",
            env: { ...process.env, ...caches, SLIM_INFO_FILE: infoFile },
        });
        log(
            `${attempt}차 시도 ${status === 0 ? "성공" : `실패(exit ${status})`}, ${((Date.now() - begin) / 1000).toFixed(1)}초`,
        );
        return status;
    };

    const first = run(1);
    if (first === 2) {
        log("설정을 읽거나 분석하는 단계에서 실패했습니다. 캐시와 무관하므로 재시도하지 않습니다.");
        return 2;
    }
    if (first !== 0) {
        log(`캐시가 손상됐을 수 있어 비우고 다시 받습니다:\n  ${Object.values(caches).join("\n  ")}`);
        for (const dir of Object.values(caches)) fs.rmSync(dir, { recursive: true, force: true });
        // CI가 갱신된 캐시를 다시 저장하도록 알린다.
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
        if (mtimeMs >= startedAt) log(`산출물 ${name}: ${(size / 1048576).toFixed(1)} MB`);
    }

    if (!smokeCheck) return 0;
    const runnable = unpackedDirs(out, startedAt).filter(
        (dir) => info.targets[hostPlatform()] != null && unpackedArch(dir) === hostArch() && hostPlatform() !== "mac",
    );
    if (runnable.length === 0) {
        log(`스모크 검사 건너뜀: 이 PC(${hostPlatform()}/${hostArch()})에서 실행할 수 있는 결과물이 없음`);
        return 0;
    }
    let failed = false;
    for (const appDir of runnable) {
        const result = smoke({ appDir, packages: packagedRootDependencies(root, appDir) });
        log(
            `스모크 검사 ${path.basename(appDir)}: 통과 ${result.ok.length}, 실패 ${result.failed.length}, 경고 ${result.warnings.length}`,
        );
        for (const line of result.warnings) log(`  경고 ${line}`);
        for (const line of result.failed) log(`  실패 ${line}`);
        failed ||= result.failed.length > 0;
    }
    return failed ? 1 : 0;
};

module.exports = { build, cacheDirs, packagedRootDependencies };
