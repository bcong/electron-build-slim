// Works out which node_modules an Electron app actually loads, and turns everything else into electron-builder
// `files` exclusions or @electron/packager `ignore` patterns. Files used at runtime are never touched.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Packages the Electron runtime already provides, or that are only needed to install/compile native modules.
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
// Folders that are never app code when an unbundled app is packaged from its sources.
const SCAN_SKIP = new Set(["node_modules", ".git"]);

// Files inside packages that are never used at runtime. Both the electron-builder globs and the packager regexes come from this data.
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
    // node-gyp intermediate output under build/{Debug,Release}/.
    buildIntermediates: ["obj", "obj.target", ".deps"],
};

const junkGlobs = () => [
    `!**/node_modules/*/**/{${JUNK.dirs.join(",")}}/**`,
    `!**/node_modules/**/*.{${JUNK.extensions.join(",")}}`,
    `!**/node_modules/**/{${JUNK.names.join(",")}}`,
    `!**/node_modules/**/build/{Debug,Release}/{${JUNK.buildIntermediates.join(",")}}/**`,
];

// Regexes for @electron/packager `ignore`. packager passes paths relative to the app folder ("/node_modules/a/b.js").
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

// Package folder -> name, following dependencies (+optional, +peer when asked) starting from `names`.
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
        // With pnpm, node_modules/<name> links into .pnpm, so child dependencies are resolved from the real path.
        const realDir = fs.realpathSync(dir);
        for (const dep of Object.keys(deps)) queue.push([dep, realDir]);
    }
    return found;
};

const rootDependencies = (rootPkg) => Object.keys({ ...rootPkg.dependencies, ...rootPkg.optionalDependencies });

// electron-vite: out/main and out/preload (the renderer is bundled). Otherwise the whole project minus node_modules.
// Scanning everything may keep renderer-only dependencies, but it never drops a module the app needs.
const defaultEntries = (root) => {
    const vite = ["out/main", "out/preload"].filter((dir) => fs.existsSync(path.join(root, dir)));
    return vite.length > 0 ? vite : ["."];
};

// Root dependencies whose name appears in the app code. Module names survive as string constants even in V8 bytecode (.jsc).
const entryDependencies = (root, rootPkg, entries) => {
    const sources = entries
        .flatMap((entry) => walkFiles(path.resolve(root, entry), SCAN_SKIP))
        .filter((file) => ENTRY_FILE.test(file))
        .map((file) => fs.readFileSync(file, "latin1"));
    if (sources.length === 0)
        throw new Error(`No app code found in: ${entries.join(", ")}. Run your bundle/compile step first.`);
    return rootDependencies(rootPkg).filter((name) => {
        const pattern = new RegExp(`${escapeRegExp(name)}(?![\\w-])`);
        return sources.some((source) => pattern.test(source));
    });
};

// Adds root dependencies that kept packages require/import without declaring them (common with patches), until nothing new is found.
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

// prebuilds/<platform>-<arch>[+<arch>] folders for other platforms/architectures.
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

// Source-only folders (src, deps) that contain no runtime files (.js/.json/.node).
const sourceOnlyDirs = (dir) =>
    ["src", "deps"]
        .map((name) => path.join(dir, name))
        .filter((sub) => fs.existsSync(sub) && !walkFiles(sub).some((file) => RUNTIME_FILE.test(file)));

const relativeToNodeModules = (root, dir) => toPosix(path.relative(path.join(root, "node_modules"), dir));
const excludeGlob = (relative) => `!**/node_modules/${relative}{,/**/*}`;

/**
 * @typedef {object} PruneOptions
 * @property {Partial<Record<"win" | "linux" | "mac", string[]>>} [targets] Architectures per target platform (default: this machine)
 * @property {string} [root] Project folder (default: current directory)
 * @property {string[]} [entries] Where the app code lives (default: out/main+out/preload, else the whole project minus node_modules)
 * @property {string[]} [keep] Root dependencies to always ship (e.g. modules required through a computed name)
 * @property {string[]} [neverShip] Extra packages to never ship, on top of the built-in list
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
    // If a platform-level `files` holds only exclusions, electron-builder prepends **/* and overrides the user's `files`.
    // So only prebuilds that no target of this build needs are excluded, in the shared `files`.
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
        /** Exclusion patterns to append to electron-builder `files` */
        files: [
            ...drop.map(excludeGlob),
            ...sourceOnly.map(excludeGlob),
            ...foreignToAll.map(excludeGlob),
            ...junkGlobs(),
        ],
    };
};

// Package names a regular electron-builder build ships: root dependencies (+optional) and their children, without peers.
const productionPackages = (root = process.cwd()) =>
    new Set(
        closure(root, rootDependencies(readJson(path.join(root, "package.json"))), {
            withPeers: false,
            neverShip: new Set(),
        }).values(),
    );

const hostArch = () => (process.arch === "arm" ? "armv7l" : process.arch);
const hostPlatform = () => Object.keys(NODE_PLATFORM).find((key) => NODE_PLATFORM[key] === process.platform);
const hostTarget = () => ({ [hostPlatform()]: [hostArch()] });

// Reads target platforms and architectures from electron-builder CLI arguments. Defaults to this machine.
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
 * Exclusion patterns to append to electron-builder `files`. Targets are read from the electron-builder CLI arguments.
 * @param {PruneOptions} [options]
 */
const pruneFiles = (options = {}) => analyze({ targets: targetsFromArgv(process.argv.slice(2)), ...options }).files;

/**
 * `ignore` regexes for @electron/packager (electron-forge `packagerConfig`). Passing an array keeps packager's default ignore rules
 * (a function would replace them). Append them to your existing `ignore` array.
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

module.exports = {
    analyze,
    productionPackages,
    pruneFiles,
    packagerIgnore,
    targetsFromArgv,
    hostPlatform,
    hostArch,
    NODE_PLATFORM,
    JUNK,
};
