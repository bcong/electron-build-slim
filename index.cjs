// Electron 앱이 실제로 불러오는 node_modules만 남기기 위한 분석. 결과를 electron-builder `files` 패턴이나
// @electron/packager `ignore` 함수로 바꿔 준다. 실행에 쓰는 파일은 건드리지 않는다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Electron 런타임이 이미 갖고 있거나, 네이티브 모듈을 설치/컴파일할 때만 쓰는 패키지.
const NEVER_SHIP = [
    "electron",
    "node-gyp",
    "prebuild-install",
    "node-addon-api",
    "nan",
    "patch-package",
    "@electron/rebuild",
    "@electron/get",
];
const ENTRY_FILE = /\.(c?js|mjs|jsc)$/;
const RUNTIME_FILE = /\.(c?js|mjs|json|node)$/;
const NODE_ARCH = { x64: "x64", ia32: "ia32", arm64: "arm64", armv7l: "arm", universal: "x64+arm64" };
const NODE_PLATFORM = { win: "win32", linux: "linux", mac: "darwin" };
// 번들러 없이 소스를 그대로 패키징하는 앱에서 산출물로 보지 않을 폴더.
const SCAN_SKIP = new Set(["node_modules", ".git"]);

// 패키지 안에서 실행에 쓰이지 않는 파일. electron-builder glob과 packager 함수를 모두 이 데이터에서 만든다.
const JUNK = {
    dirs: [
        "test",
        "tests",
        "__tests__",
        "example",
        "examples",
        "docs",
        "benchmark",
        "benchmarks",
        "coverage",
        ".github",
    ],
    extensions: [
        "md",
        "markdown",
        "map",
        "ts",
        "mts",
        "cts",
        "c",
        "cc",
        "cpp",
        "cxx",
        "h",
        "hh",
        "hpp",
        "lzz",
        "gyp",
        "gypi",
        "mk",
        "o",
        "obj",
        "pdb",
        "lib",
        "exp",
        "iobj",
        "ipdb",
        "ilk",
        "tlog",
        "lastbuildstate",
        "vcxproj",
        "filters",
        "sln",
        "tar.gz",
    ],
    names: [
        "Makefile",
        "CMakeLists.txt",
        ".npmignore",
        ".eslintrc*",
        ".prettierrc*",
        "tsconfig*.json",
        "CHANGELOG*",
        "HISTORY*",
    ],
    // node-gyp 중간 산출물. build/{Debug,Release}/ 아래.
    buildIntermediates: ["obj", "obj.target", ".deps"],
};

const junkGlobs = () => [
    `!**/node_modules/*/**/{${JUNK.dirs.join(",")}}/**`,
    `!**/node_modules/**/*.{${JUNK.extensions.join(",")}}`,
    `!**/node_modules/**/{${JUNK.names.join(",")}}`,
    `!**/node_modules/**/build/{Debug,Release}/{${JUNK.buildIntermediates.join(",")}}/**`,
];

// @electron/packager ignore용 정규식. packager는 앱 폴더 기준 경로("/node_modules/a/b.js")를 넘긴다.
const SEP = "[\\\\/]";
const NOT_SEP = "[^\\\\/]";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (items, map = escapeRegExp) => `(?:${items.map(map).join("|")})`;
const wildcard = (text) => escapeRegExp(text).replace(/\\\*/g, `${NOT_SEP}*`);
const IN_PACKAGE = `${SEP}node_modules${SEP}(?:@${NOT_SEP}+${SEP})?${NOT_SEP}+${SEP}(?:.*${SEP})?`;
const junkRegExps = () => [
    new RegExp(`${IN_PACKAGE}${alternation(JUNK.dirs)}(?:${SEP}|$)`),
    new RegExp(`${SEP}node_modules${SEP}.*\\.${alternation(JUNK.extensions)}$`),
    new RegExp(`${SEP}node_modules${SEP}(?:.*${SEP})?${alternation(JUNK.names, wildcard)}$`),
    new RegExp(
        `${SEP}node_modules${SEP}.*${SEP}build${SEP}(?:Debug|Release)${SEP}${alternation(JUNK.buildIntermediates)}(?:${SEP}|$)`,
    ),
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const walkFiles = (target, skip = new Set()) => {
    if (!fs.existsSync(target)) return [];
    if (fs.statSync(target).isFile()) return [target];
    const files = [];
    const stack = [target];
    while (stack.length > 0) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) files.push(full);
        }
    }
    return files;
};
const toPosix = (file) => file.split(path.sep).join("/");

const resolvePackageDir = (name, fromDir, root) => {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, "node_modules", name);
        if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
        if (dir === root || path.dirname(dir) === dir) return null;
    }
};

// names에서 출발해 dependencies(+optional, +peer 옵션)를 따라간 패키지 폴더 -> 이름.
const closure = (root, names, { withPeers, neverShip }) => {
    const found = new Map();
    const queue = names.map((name) => [name, root]);
    while (queue.length > 0) {
        const [name, fromDir] = queue.shift();
        if (!withPeers && (neverShip.has(name) || name.startsWith("@types/"))) continue;
        const dir = resolvePackageDir(name, fromDir, root);
        if (dir == null || found.has(dir)) continue;
        found.set(dir, name);
        const pkg = readJson(path.join(dir, "package.json"));
        const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...(withPeers ? pkg.peerDependencies : {}) };
        // pnpm은 node_modules/<이름>이 .pnpm 안 실제 폴더로 가는 링크라서, 하위 의존성은 실제 경로에서 찾는다.
        const realDir = fs.realpathSync(dir);
        for (const dep of Object.keys(deps)) queue.push([dep, realDir]);
    }
    return found;
};

const rootDependencies = (rootPkg) => Object.keys({ ...rootPkg.dependencies, ...rootPkg.optionalDependencies });

// electron-vite는 out/main, out/preload(렌더러는 번들됨). 그 밖에는 node_modules를 뺀 프로젝트 전체.
// 전체를 보면 렌더러 전용 의존성까지 남을 수 있지만, 필요한 모듈을 빼는 일은 없다.
const defaultEntries = (root) => {
    const vite = ["out/main", "out/preload"].filter((dir) => fs.existsSync(path.join(root, dir)));
    return vite.length > 0 ? vite : ["."];
};

// 루트 dependencies 중 산출물에 이름이 나오는 것. 메인이 V8 바이트코드(.jsc)여도 모듈 이름은 문자열 상수로 남는다.
const entryDependencies = (root, rootPkg, entries) => {
    const sources = entries
        .flatMap((entry) => walkFiles(path.resolve(root, entry), SCAN_SKIP))
        .filter((file) => ENTRY_FILE.test(file))
        .map((file) => fs.readFileSync(file, "latin1"));
    if (sources.length === 0)
        throw new Error(`앱 코드가 없습니다: ${entries.join(", ")}. 번들 빌드를 먼저 실행했는지 확인하세요.`);
    return rootDependencies(rootPkg).filter((name) => {
        const pattern = new RegExp(`${escapeRegExp(name)}(?![\\w-])`);
        return sources.some((source) => pattern.test(source));
    });
};

// 패치 등으로 package.json에 선언하지 않고 require/import하는 루트 의존성을, 더 늘지 않을 때까지 찾아 넣는다.
const runtimeClosure = (root, rootPkg, starts, neverShip) => {
    const codeByDir = new Map();
    const codeOf = (dir) => {
        if (!codeByDir.has(dir)) {
            const files = walkFiles(dir).filter((file) => /\.(c?js|mjs)$/.test(file));
            codeByDir.set(dir, files.map((file) => fs.readFileSync(file, "latin1")).join("\n"));
        }
        return codeByDir.get(dir);
    };
    const undeclared = [];
    for (;;) {
        const runtime = closure(root, [...starts, ...undeclared], { withPeers: false, neverShip });
        const kept = new Set(runtime.values());
        const missing = rootDependencies(rootPkg).filter((name) => !kept.has(name) && !neverShip.has(name));
        const found = missing.filter((name) => {
            const pattern = new RegExp(
                `(?:require\\s*\\(|import\\s*\\(|from)\\s*["']${escapeRegExp(name)}(?:/[^"']*)?["']`,
            );
            return [...runtime.keys()].some((dir) => pattern.test(codeOf(dir)));
        });
        if (found.length === 0) return { runtime, undeclared };
        undeclared.push(...found);
    }
};

// prebuilds/<platform>-<arch>[+<arch>] 중 대상 플랫폼/아키텍처가 아닌 폴더.
const foreignPrebuilds = (dir, platform, archs) => {
    const prebuilds = path.join(dir, "prebuilds");
    if (!fs.existsSync(prebuilds)) return [];
    const wanted = archs.flatMap((arch) => (NODE_ARCH[arch] ?? arch).split("+"));
    return fs
        .readdirSync(prebuilds, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => {
            const [prebuildPlatform, archList = ""] = name.split(/-(.*)/s);
            return (
                prebuildPlatform !== NODE_PLATFORM[platform] ||
                !archList.split("+").some((arch) => wanted.includes(arch))
            );
        })
        .map((name) => path.join(prebuilds, name));
};

// 실행 파일(.js/.json/.node)이 하나도 없는 소스 폴더(src, deps).
const sourceOnlyDirs = (dir) =>
    ["src", "deps"]
        .map((name) => path.join(dir, name))
        .filter((sub) => fs.existsSync(sub) && !walkFiles(sub).some((file) => RUNTIME_FILE.test(file)));

const relativeToNodeModules = (root, dir) => toPosix(path.relative(path.join(root, "node_modules"), dir));
const excludeGlob = (relative) => `!**/node_modules/${relative}{,/**/*}`;

/**
 * @typedef {object} PruneOptions
 * @property {Partial<Record<"win" | "linux" | "mac", string[]>>} [targets] 대상 플랫폼별 아키텍처 (기본: 현재 OS/아키텍처)
 * @property {string} [root] 프로젝트 폴더 (기본: 현재 폴더)
 * @property {string[]} [entries] 앱 코드 위치 (기본: out/main+out/preload, 없으면 node_modules를 뺀 프로젝트 전체)
 * @property {string[]} [keep] 분석과 상관없이 반드시 넣을 루트 의존성 (모듈 이름을 변수로 만들어 require하는 경우)
 * @property {string[]} [neverShip] 기본 목록에 더해 절대 넣지 않을 패키지
 */

/** @param {PruneOptions} [options] */
const analyze = ({ root = process.cwd(), targets = hostTarget(), entries, keep = [], neverShip = [] } = {}) => {
    const rootPkg = readJson(path.join(root, "package.json"));
    const never = new Set([...NEVER_SHIP, ...neverShip]);
    const entryDirs = entries ?? defaultEntries(root);
    const starts = [...new Set([...entryDependencies(root, rootPkg, entryDirs), ...keep])];
    const { runtime, undeclared } = runtimeClosure(root, rootPkg, starts, never);
    const shipped = closure(root, rootDependencies(rootPkg), { withPeers: true, neverShip: never });
    const kept = new Set(runtime.values());
    const drop = [...new Set(shipped.values())].filter((name) => !kept.has(name)).sort();
    const sourceOnly = [...runtime.keys()].flatMap(sourceOnlyDirs).map((dir) => relativeToNodeModules(root, dir));
    const prebuilds = Object.fromEntries(
        Object.entries(targets).map(([platform, archs]) => [
            platform,
            [...runtime.keys()]
                .flatMap((dir) => foreignPrebuilds(dir, platform, archs))
                .map((dir) => relativeToNodeModules(root, dir)),
        ]),
    );
    // 플랫폼별 files는 제외 패턴만 있으면 electron-builder가 **/*를 덧붙여 사용자 files를 무력화한다.
    // 그래서 이번 빌드의 모든 대상에 필요 없는 prebuilds만 공통 files에서 뺀다.
    const perPlatform = Object.values(prebuilds);
    const foreignToAll =
        perPlatform.length === 0 ? [] : perPlatform[0].filter((dir) => perPlatform.every((dirs) => dirs.includes(dir)));
    return {
        entryDirs,
        entries: starts,
        undeclared,
        keep: [...kept].sort(),
        drop,
        sourceOnly,
        prebuilds: foreignToAll,
        /** electron-builder `files`에 이어 붙일 제외 패턴 */
        files: [
            ...drop.map(excludeGlob),
            ...sourceOnly.map(excludeGlob),
            ...foreignToAll.map(excludeGlob),
            ...junkGlobs(),
        ],
    };
};

const hostArch = () => (process.arch === "arm" ? "armv7l" : process.arch);
const hostPlatform = () => Object.keys(NODE_PLATFORM).find((key) => NODE_PLATFORM[key] === process.platform);
const hostTarget = () => ({ [hostPlatform()]: [hostArch()] });

// electron-builder CLI 인자에서 대상 플랫폼과 아키텍처를 읽는다. 없으면 현재 OS/아키텍처.
const targetsFromArgv = (argv) => {
    const has = (...flags) =>
        argv.some((arg) => flags.includes(arg) || flags.some((flag) => arg.startsWith(`${flag}=`)));
    const platforms = [
        has("--win", "-w", "--windows") && "win",
        has("--linux", "-l") && "linux",
        has("--mac", "-m", "--macos", "-o") && "mac",
        ...argv
            .filter((arg) => /^-[wlm]{2,3}$/.test(arg))
            .flatMap((arg) => [...arg.slice(1)].map((c) => ({ w: "win", l: "linux", m: "mac" })[c])),
    ].filter(Boolean);
    const archs = Object.keys(NODE_ARCH).filter((arch) => argv.includes(`--${arch}`));
    const unique = [...new Set(platforms.length > 0 ? platforms : [hostPlatform()])];
    return Object.fromEntries(
        unique.map((platform) => [
            platform,
            archs.length > 0 ? archs : [platform === hostPlatform() ? hostArch() : "x64"],
        ]),
    );
};

/**
 * electron-builder 설정 `files`에 이어 붙일 제외 패턴. 대상은 electron-builder CLI 인자에서 읽는다.
 * @param {PruneOptions} [options]
 */
const pruneFiles = (options = {}) => analyze({ targets: targetsFromArgv(process.argv.slice(2)), ...options }).files;

/**
 * @electron/packager(electron-forge의 packagerConfig)용 `ignore` 정규식 배열. 배열로 넘기면 packager의 기본 제외 규칙이 유지된다.
 * (함수로 넘기면 packager는 기본 규칙을 쓰지 않는다.) 기존 ignore 배열 뒤에 이어 붙여 쓴다.
 * @param {PruneOptions} [options]
 * @returns {RegExp[]}
 */
const packagerIgnore = (options = {}) => {
    const result = analyze(options);
    const pathPattern = (relative) => relative.split("/").map(escapeRegExp).join(SEP);
    return [
        ...result.drop.map(
            (name) =>
                new RegExp(`${SEP}node_modules${SEP}(?:.*${SEP}node_modules${SEP})?${pathPattern(name)}(?:${SEP}|$)`),
        ),
        ...[...result.sourceOnly, ...result.prebuilds].map(
            (dir) => new RegExp(`^${SEP}node_modules${SEP}${pathPattern(dir)}(?:${SEP}|$)`),
        ),
        ...junkRegExps(),
    ];
};

module.exports = { analyze, pruneFiles, packagerIgnore, targetsFromArgv, hostPlatform, hostArch, NODE_PLATFORM, JUNK };
