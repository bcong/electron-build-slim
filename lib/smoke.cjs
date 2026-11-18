// 패키징된 앱의 Electron 런타임(ELECTRON_RUN_AS_NODE)에서 실행용 의존성을 require해 본다.
// 정리 규칙이 필요한 파일을 뺐을 때만 실패로 본다. 다른 OS 전용 모듈의 로드 오류는 경고로 남긴다.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 파일이 빠졌다는 뜻의 오류. 'electron'은 실제 실행 때 내장 모듈이라 제외한다.
const MISSING = [
    /Cannot find module '(?!electron')[^']+'/,
    /Could not locate the bindings file/,
    /No native build was found/,
];
const NOT_MAIN_BINARY = /^(chrome-sandbox|chrome_crashpad_handler|elevate|Uninstall.*)(\.exe)?$/i;

// 앱 폴더에서 가장 큰 실행 파일(Electron 본체)을 찾는다.
const findExecutable = (appDir) => {
    const isWindows = process.platform === "win32";
    const candidates = fs
        .readdirSync(appDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !NOT_MAIN_BINARY.test(entry.name))
        .filter((entry) => (isWindows ? entry.name.endsWith(".exe") : !entry.name.includes(".")))
        .map((entry) => path.join(appDir, entry.name));
    if (candidates.length === 0) throw new Error(`실행 파일을 찾지 못했습니다: ${appDir}`);
    return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
};

const appRootOf = (appDir) => {
    const resources = path.join(appDir, "resources");
    const root = ["app.asar", "app"]
        .map((name) => path.join(resources, name))
        .find((candidate) => fs.existsSync(candidate));
    if (root == null) throw new Error(`resources/app.asar 가 없습니다: ${appDir}`);
    return root;
};

const CHECK_SCRIPT = `
const { createRequire } = require("node:module");
const [appRoot, ...names] = JSON.parse(process.env.SLIM_SMOKE);
const load = createRequire(appRoot + "/package.json");
for (const name of names) {
    try { load(name); console.log("OK\\t" + name); }
    catch (error) { console.log("ERR\\t" + name + "\\t" + String(error && error.message).split("\\n")[0]); }
}
process.exit(0);
`;

/**
 * @param {{ appDir: string, packages: string[] }} options appDir: win-unpacked 같은 폴더
 * @returns {{ ok: string[], failed: string[], warnings: string[] }}
 */
const smoke = ({ appDir: dir, packages }) => {
    const appDir = path.resolve(dir);
    const executable = findExecutable(appDir);
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slim-smoke-")), "check.js");
    fs.writeFileSync(script, CHECK_SCRIPT);
    const { stdout, stderr, status, error } = spawnSync(executable, [script], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            SLIM_SMOKE: JSON.stringify([appRootOf(appDir), ...packages]),
        },
        encoding: "utf8",
        timeout: 120_000,
    });
    fs.rmSync(path.dirname(script), { recursive: true, force: true });
    if (error || status !== 0)
        throw new Error(
            `스모크 검사 실행 실패 (${executable}): ${error?.message ?? `exit ${status}`}\n${stderr?.slice(-2000) ?? ""}`,
        );
    const result = { ok: [], failed: [], warnings: [] };
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const [kind, name, message = ""] = line.split("\t");
        if (kind === "OK") result.ok.push(name);
        else if (MISSING.some((pattern) => pattern.test(message))) result.failed.push(`${name}: ${message}`);
        else if (kind === "ERR") result.warnings.push(`${name}: ${message}`);
    }
    return result;
};

module.exports = { smoke, findExecutable };
