// Collects benchmark runs into benchmarks/results.json and renders the README table and the GitHub Pages site.
// Usage: node benchmarks/collect.cjs <results folder> <apps folder>
// Smoke checks are re-run with this repository's tool so every row is judged by the same code.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { smoke } = require("../lib/smoke.cjs");
const { packagedRootDependencies } = require("../lib/build.cjs");
const { productionPackages } = require("../index.cjs");

const [resultsRoot, appsRoot] = process.argv.slice(2);
if (!resultsRoot || !appsRoot) throw new Error("usage: node benchmarks/collect.cjs <results folder> <apps folder>");

// Apps measured, with what result.json does not record. `slim`/`opts` name a different run folder when the
// default one was superseded (LosslessCut was re-measured after the renderer fix).
const APPS = [
    { id: "caprine", name: "Caprine", repo: "sindresorhus/caprine", tag: "v2.61.0", electron: "29.0.1", pm: "npm" },
    {
        id: "heroicgameslauncher",
        name: "Heroic Games Launcher",
        repo: "Heroic-Games-Launcher/HeroicGamesLauncher",
        tag: "v2.22.4",
        electron: "43.1.1",
        pm: "pnpm (hoisted)",
    },
    {
        id: "hyper",
        name: "Hyper",
        repo: "vercel/hyper",
        tag: "v3.4.1",
        electron: "20.3.6",
        pm: "yarn 1",
        run: "hyper-final",
        opts: "hyper-final-opts",
        appSubdir: "target",
    },
    {
        id: "losslesscut",
        name: "LosslessCut",
        repo: "mifi/lossless-cut",
        tag: "v3.70.2",
        electron: "42.11.15",
        pm: "yarn 4",
        slim: "losslesscut-fixed",
        opts: "losslesscut-opts-fixed",
    },
    {
        id: "mattermost",
        name: "Mattermost Desktop",
        repo: "mattermost/desktop",
        tag: "v6.4.0",
        electron: "45.2.1",
        pm: "npm",
        run: "mattermost-final",
        opts: "mattermost-final-opts",
    },
    {
        id: "peardesktop",
        name: "Pear Desktop (YouTube Music)",
        repo: "pear-devs/pear-desktop",
        tag: "v3.12.1",
        electron: "45.3.2",
        pm: "pnpm (isolated)",
    },
    {
        id: "rocketchat",
        name: "Rocket.Chat Desktop",
        repo: "RocketChat/Rocket.Chat.Electron",
        tag: "4.19.3",
        electron: "43.8.1",
        pm: "yarn 4",
    },
    { id: "stretchly", name: "Stretchly", repo: "hovancik/stretchly", tag: "v1.22.1", electron: "43.4.0", pm: "npm" },
    {
        id: "superproductivity",
        name: "Super Productivity",
        repo: "johannesjo/super-productivity",
        tag: "v20.0.0",
        electron: "44.10.0",
        pm: "npm",
    },
    { id: "upscayl", name: "Upscayl", repo: "upscayl/upscayl", tag: "v2.15.0", electron: "27.3.10", pm: "npm" },
];

const read = (folder) => {
    const file = path.join(resultsRoot, folder, "result.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};
const installerBytes = (variant) => variant?.size?.installers?.reduce((sum, item) => sum + item.bytes, 0) ?? null;
const firstPage = (variant) => variant?.launch?.pages?.[0] ?? null;
const smokeFailures = (variant, appDir) => {
    const dir = variant?.size?.unpackedDir;
    if (!dir || !fs.existsSync(dir)) return null;
    return smoke({ appDir: dir, packages: packagedRootDependencies(appDir, dir), shipped: productionPackages(appDir) })
        .failed.length;
};

// Rows already collected are kept when an app's build outputs have since been deleted.
const resultsFile = path.join(__dirname, "results.json");
const previous = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, "utf8")).apps : [];

const rows = [];
for (const app of APPS) {
    const main = read(app.run ?? app.id);
    const slimRun = app.slim ? read(app.slim) : main;
    const optsRun = read(app.opts ?? `${app.id}-opts`);
    // Two-package.json apps ship the dependencies of their app folder (directories.app).
    const appDir = path.join(appsRoot, app.id, app.appSubdir ?? "");
    const kept = previous.find((row) => row.id === app.id);
    if (
        !main?.base ||
        !slimRun?.slim ||
        !fs.existsSync(appDir) ||
        !fs.existsSync(slimRun.slim.size?.unpackedDir ?? "")
    ) {
        if (kept) rows.push(kept);
        console.log(kept ? `${app.name}: kept previous row` : `skip ${app.name}: no complete run`);
        continue;
    }
    const base = main.base;
    const slim = slimRun.slim;
    const opts = optsRun?.slim ?? null;
    const sameScreen = (variant) => {
        const a = firstPage(base);
        const b = firstPage(variant);
        return Boolean(a && b && a.title === b.title && a.textLength === b.textLength && variant.launch.alive);
    };
    rows.push({
        ...app,
        version: main.appVersion,
        electronBuilder: main.electronBuilder,
        base: {
            installer: installerBytes(base),
            unpacked: base.size.unpackedBytes,
            smokeFailures: smokeFailures(base, appDir),
        },
        slim: {
            installer: installerBytes(slim),
            unpacked: slim.size.unpackedBytes,
            smokeFailures: smokeFailures(slim, appDir),
            sameScreen: sameScreen(slim),
            firstWindowSeconds: slim.launch?.firstWindowSeconds ?? null,
        },
        opts: opts
            ? {
                  installer: installerBytes(opts),
                  unpacked: opts.size.unpackedBytes,
                  smokeFailures: smokeFailures(opts, appDir),
                  launched: Boolean(opts.launch?.alive),
              }
            : null,
    });
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);
const pct = (after, before) => {
    const value = ((after - before) / before) * 100;
    return `${Math.abs(value) < 0.05 ? "0.0" : value.toFixed(1)}%`;
};
const json = `${JSON.stringify({ platform: "win32-x64", target: "nsis", apps: rows }, null, 2)}\n`;
fs.writeFileSync(resultsFile, json);
fs.mkdirSync(path.join(__dirname, "..", "docs"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "..", "docs", "results.json"), json);

const table = [
    "| App | Electron | electron-builder | Installer (base → slim) | Unpacked (base → slim) | With opt-ins¹ | Same screen² |",
    "|---|---|---|---|---|---|---|",
    ...rows
        .map((row) =>
            [
                `[${row.name}](https://github.com/${row.repo}) ${row.version ? `v${row.version}` : ""}`,
                row.electron ?? "",
                row.electronBuilder,
                `${mb(row.base.installer)} → ${mb(row.slim.installer)} MiB (**${pct(row.slim.installer, row.base.installer)}**)`,
                `${mb(row.base.unpacked)} → ${mb(row.slim.unpacked)} MiB (**${pct(row.slim.unpacked, row.base.unpacked)}**)`,
                row.opts ? `${mb(row.opts.installer)} MiB (**${pct(row.opts.installer, row.base.installer)}**)` : "",
                row.slim.sameScreen && row.slim.smokeFailures === 0 ? "✅" : "⚠️",
            ].join(" | "),
        )
        .map((line) => `| ${line} |`),
].join("\n");

const section = `## Benchmarks

Real, well-known open-source Electron apps, built from their public source on Windows x64 (NSIS installer), once with their own \`electron-builder\` setup and once with \`electron-build-slim\` (default level). Sizes in MiB.

${table}

¹ \`--slim-languages en-US --slim-strip-webgpu\` on top of the default. This changes the app's locale, so it is opt-in. Hyper uses electron-builder 23, which has no \`electronLanguages\` option, so there it equals the default.
² The slimmed build launched, stayed alive, and showed the same window title and text as the regular build; the smoke check found nothing missing.

Apps whose own config already ships only what they need (Pear Desktop, Super Productivity) gain almost nothing by default; apps that ship whole dependency trees gain the most. Details, method and raw data: [benchmarks/](benchmarks/) and the [project site](https://bcong.github.io/electron-build-slim/).`;

const readmePath = path.join(__dirname, "..", "README.md");
const readme = fs.readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");
const start = readme.indexOf("<!-- BENCHMARKS -->");
const end = readme.indexOf("<!-- /BENCHMARKS -->");
const block = `<!-- BENCHMARKS -->\n${section}\n<!-- /BENCHMARKS -->`;
fs.writeFileSync(
    readmePath,
    end === -1
        ? readme.replace("<!-- BENCHMARKS -->", block)
        : readme.slice(0, start) + block + readme.slice(end + "<!-- /BENCHMARKS -->".length),
);
console.log(table);
