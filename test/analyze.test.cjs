"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { analyze, packagerIgnore, targetsFromArgv } = require("../index.cjs");

// Fake project: used, unused, undeclared and build-only dependencies, plus a native module with prebuilds.
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

test("keeps only dependencies the app code uses, and their children", () => {
    const result = analyze({ root: fixture(), targets: { win: ["x64"] } });
    assert.deepEqual(result.entries.sort(), ["native", "used"]);
    assert.deepEqual(result.undeclared, ["patched-dep"]);
    assert.deepEqual(result.keep, ["native", "node-gyp-build", "patched-dep", "used", "used-child"]);
    assert.deepEqual(result.drop, ["dynamic-dep", "electron", "node-addon-api", "unused", "unused-child"]);
});

test("keep option ships dependencies the analysis cannot see", () => {
    const result = analyze({ root: fixture(), targets: { win: ["x64"] }, keep: ["dynamic-dep"] });
    assert.ok(result.keep.includes("dynamic-dep"));
    assert.ok(!result.drop.includes("dynamic-dep"));
});

test("drops prebuilds for other platforms and source-only folders", () => {
    const result = analyze({ root: fixture(), targets: { linux: ["arm64"] } });
    assert.deepEqual(result.prebuilds.sort(), ["native/prebuilds/darwin-x64+arm64", "native/prebuilds/win32-x64"]);
    assert.deepEqual(result.sourceOnly, ["native/src"]);
});

test("multi-platform builds keep prebuilds any target needs", () => {
    const result = analyze({ root: fixture(), targets: { win: ["x64"], linux: ["arm64"] } });
    assert.deepEqual(result.prebuilds, ["native/prebuilds/darwin-x64+arm64"]);
});

test("electron-builder files patterns are exclusions only", () => {
    const { files } = analyze({ root: fixture(), targets: { win: ["x64"] } });
    assert.ok(files.length > 0);
    assert.ok(files.every((pattern) => pattern.startsWith("!")));
    assert.ok(files.includes("!**/node_modules/unused{,/**/*}"));
});

test("packager ignore regexes", () => {
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

test("reads targets from electron-builder CLI arguments", () => {
    assert.deepEqual(targetsFromArgv(["--linux", "--arm64"]), { linux: ["arm64"] });
    assert.deepEqual(targetsFromArgv(["-wl", "--x64"]), { win: ["x64"], linux: ["x64"] });
    assert.deepEqual(targetsFromArgv(["--win=nsis", "--ia32", "--x64"]), { win: ["x64", "ia32"] });
});
