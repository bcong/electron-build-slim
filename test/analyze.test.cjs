"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { analyze, packagerIgnore, targetsFromArgv } = require("../index.cjs");

// 가짜 프로젝트: 앱 코드가 쓰는 의존성, 안 쓰는 의존성, 선언 없이 쓰는 의존성, 빌드 전용 의존성, prebuilds를 가진 네이티브 모듈.
const makeProject = (files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "slim-test-"));
    for (const [file, content] of Object.entries(files)) {
        const full = path.join(root, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
    }
    return root;
};
const pkg = (name, extra = {}) => ({ name, version: "1.0.0", ...extra });

const fixture = () =>
    makeProject({
        "package.json": pkg("app", {
            main: "main.js",
            dependencies: { used: "1", unused: "1", native: "1", "patched-dep": "1", "dynamic-dep": "1" },
            devDependencies: { electron: "1" },
        }),
        "main.js": 'require("used"); require("./lib/a");',
        "lib/a.js": 'const n = require("native");',
        "node_modules/used/package.json": pkg("used", {
            dependencies: { "used-child": "1" },
            peerDependencies: { electron: "*" },
        }),
        "node_modules/used/index.js": 'require("used-child"); require("patched-dep");',
        "node_modules/used/README.md": "# used",
        "node_modules/used/test/a.test.js": "",
        "node_modules/used-child/package.json": pkg("used-child"),
        "node_modules/used-child/index.js": "",
        "node_modules/unused/package.json": pkg("unused", { dependencies: { "unused-child": "1" } }),
        "node_modules/unused-child/package.json": pkg("unused-child"),
        "node_modules/patched-dep/package.json": pkg("patched-dep"),
        "node_modules/dynamic-dep/package.json": pkg("dynamic-dep"),
        "node_modules/native/package.json": pkg("native", {
            dependencies: { "node-gyp-build": "1", "node-addon-api": "1" },
        }),
        "node_modules/native/index.js": "",
        "node_modules/native/prebuilds/win32-x64/node.napi.node": "",
        "node_modules/native/prebuilds/linux-arm64/node.napi.node": "",
        "node_modules/native/prebuilds/darwin-x64+arm64/node.napi.node": "",
        "node_modules/native/src/binding.cc": "",
        "node_modules/node-gyp-build/package.json": pkg("node-gyp-build"),
        "node_modules/node-addon-api/package.json": pkg("node-addon-api"),
        "node_modules/electron/package.json": pkg("electron"),
    });

test("앱 코드가 쓰는 의존성과 그 하위 의존성만 남긴다", () => {
    const result = analyze({ root: fixture(), targets: { win: ["x64"] } });
    assert.deepEqual(result.entries.sort(), ["native", "used"]);
    assert.deepEqual(result.undeclared, ["patched-dep"]);
    assert.deepEqual(result.keep, ["native", "node-gyp-build", "patched-dep", "used", "used-child"]);
    assert.deepEqual(result.drop, ["dynamic-dep", "electron", "node-addon-api", "unused", "unused-child"]);
});

test("keep 옵션은 분석이 못 찾는 의존성을 남긴다", () => {
    const result = analyze({ root: fixture(), targets: { win: ["x64"] }, keep: ["dynamic-dep"] });
    assert.ok(result.keep.includes("dynamic-dep"));
    assert.ok(!result.drop.includes("dynamic-dep"));
});

test("대상이 아닌 OS/아키텍처의 prebuilds와 소스 전용 폴더를 뺀다", () => {
    const result = analyze({ root: fixture(), targets: { linux: ["arm64"] } });
    assert.deepEqual(result.prebuilds.sort(), ["native/prebuilds/darwin-x64+arm64", "native/prebuilds/win32-x64"]);
    assert.deepEqual(result.sourceOnly, ["native/src"]);
});

test("여러 플랫폼을 함께 빌드하면 어느 대상에든 필요한 prebuilds는 남긴다", () => {
    const result = analyze({ root: fixture(), targets: { win: ["x64"], linux: ["arm64"] } });
    assert.deepEqual(result.prebuilds, ["native/prebuilds/darwin-x64+arm64"]);
});

test("electron-builder files 패턴은 제외 패턴만 만든다", () => {
    const { files } = analyze({ root: fixture(), targets: { win: ["x64"] } });
    assert.ok(files.length > 0);
    assert.ok(files.every((pattern) => pattern.startsWith("!")));
    assert.ok(files.includes("!**/node_modules/unused{,/**/*}"));
});

test("packager ignore 정규식", () => {
    const patterns = packagerIgnore({ root: fixture(), targets: { win: ["x64"] } });
    const ignored = (file) => patterns.some((pattern) => pattern.test(file));
    const cases = [
        ["/node_modules/unused/index.js", true],
        ["/node_modules/unused", true],
        ["/node_modules/a/node_modules/unused/x.js", true],
        ["/node_modules/unused-child-not/x.js", false],
        ["/node_modules/used/index.js", false],
        ["/node_modules/used/README.md", true],
        ["/node_modules/used/test/a.test.js", true],
        ["/node_modules/native/prebuilds/win32-x64/node.napi.node", false],
        ["/node_modules/native/prebuilds/linux-arm64/node.napi.node", true],
        ["/node_modules/native/src/binding.cc", true],
        ["/node_modules/x/build/Release/obj/a.obj", true],
        ["/node_modules/x/build/Release/x.node", false],
        [String.raw`\node_modules\unused\a.js`, true],
        ["/main.js", false],
        ["/lib/a.js", false],
    ];
    for (const [file, expected] of cases) assert.equal(ignored(file), expected, file);
});

test("electron-builder CLI 인자에서 대상을 읽는다", () => {
    assert.deepEqual(targetsFromArgv(["--linux", "--arm64"]), { linux: ["arm64"] });
    assert.deepEqual(targetsFromArgv(["-wl", "--x64"]), { win: ["x64"], linux: ["x64"] });
    assert.deepEqual(targetsFromArgv(["--win=nsis", "--ia32", "--x64"]), { win: ["x64", "ia32"] });
});
