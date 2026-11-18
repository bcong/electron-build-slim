// Builds one app with its own electron-builder and with electron-build-slim, then compares sizes, the smoke check and a real launch.
// Usage: node benchmarks/bench.cjs --app <app folder> --name <id> [--args "<electron-builder args>"] [--slim-args "<--slim-* args>"]
//            [--wait 15] [--skip-base] [--skip-build] [--out <results folder>]
// Install the app's dependencies and run its bundle/compile step first. Results go to <out>/<id>/ (default: benchmarks/results).
"use strict";
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TOOL = path.resolve(__dirname, "..");
const { smoke, findExecutable } = require(`${TOOL}/lib/smoke.cjs`);
const { productionPackages } = require(`${TOOL}/index.cjs`);
const { packagedRootDependencies } = require(`${TOOL}/lib/build.cjs`);
const { asarSizes } = require(`${TOOL}/lib/report.cjs`);

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const app = path.resolve(opt("app"));
const name = opt("name");
const builderArgs = (opt("args", "--win --x64") ?? "").split(" ").filter(Boolean);
const slimArgs = (opt("slim-args", "") ?? "").split(" ").filter(Boolean);
const waitSeconds = Number(opt("wait", "15"));
if (!opt("app") || !name) throw new Error("--app and --name are required");

const resultDir = path.resolve(opt("out", path.join(__dirname, "results")), name);
const cacheDir = path.resolve(opt("out", path.join(__dirname, "results")), ".cache", name);
fs.mkdirSync(resultDir, { recursive: true });
const env = {
    ...process.env,
    ELECTRON_CACHE: path.join(cacheDir, "electron"),
    ELECTRON_BUILDER_CACHE: path.join(cacheDir, "electron-builder"),
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
};
const log = (message) => console.log(`[bench:${name}] ${message}`);

const dirSize = (dir) => {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) total += fs.statSync(full).size;
        }
    }
    return total;
};

const runBuild = (variant) => {
    const out = path.join(resultDir, variant);
    fs.rmSync(out, { recursive: true, force: true });
    const outArg = `-c.directories.output=${out}`;
    const command =
        variant === "base"
            ? [
                  require.resolve("electron-builder/cli.js", { paths: [app] }),
                  ...builderArgs,
                  "--publish",
                  "never",
                  outArg,
                  `-c.electronDownload.cache=${env.ELECTRON_CACHE}`,
              ]
            : [`${TOOL}/bin/electron-build-slim.cjs`, ...builderArgs, "--publish", "never", outArg, ...slimArgs];
    const started = Date.now();
    const logFile = path.join(resultDir, `${variant}.log`);
    const result = spawnSync(process.execPath, command, { cwd: app, env, encoding: "utf8", maxBuffer: 1 << 28 });
    fs.writeFileSync(logFile, `${result.stdout}\n${result.stderr}`);
    const seconds = (Date.now() - started) / 1000;
    log(`${variant} build exit=${result.status} in ${seconds.toFixed(1)}s (log: ${logFile})`);
    return { status: result.status, seconds, out };
};

const measure = (out) => {
    const entries = fs.existsSync(out) ? fs.readdirSync(out, { withFileTypes: true }) : [];
    const installers = entries
        .filter((entry) => entry.isFile() && /\.(exe|msi|AppImage|deb|rpm|snap|dmg|zip|7z)$/i.test(entry.name))
        .map((entry) => ({ file: entry.name, bytes: fs.statSync(path.join(out, entry.name)).size }));
    const unpacked = entries.find((entry) => entry.isDirectory() && /-unpacked$/.test(entry.name));
    const appDir = unpacked ? path.join(out, unpacked.name) : null;
    const asar = appDir ? path.join(appDir, "resources", "app.asar") : null;
    return {
        installers,
        unpackedDir: appDir,
        unpackedBytes: appDir ? dirSize(appDir) : null,
        asarTop:
            asar && fs.existsSync(asar)
                ? asarSizes(asar, app)
                      .slice(0, 10)
                      .map((row) => ({ name: row.name, bytes: row.packed + row.unpacked }))
                : [],
    };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJson = async (port, route) => (await fetch(`http://127.0.0.1:${port}${route}`)).json();
const cdp = async (url) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    };
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    return {
        send: (method, params = {}) =>
            Promise.race([
                new Promise((resolve) => (pending.set(++id, resolve), ws.send(JSON.stringify({ id, method, params })))),
                sleep(20000).then(() => ({ timeout: method })),
            ]),
        close: () => ws.close(),
    };
};

const appDataSnapshot = () =>
    new Set(
        [process.env.APPDATA, process.env.LOCALAPPDATA]
            .filter(Boolean)
            .flatMap((dir) => fs.readdirSync(dir).map((entry) => path.join(dir, entry))),
    );

// Launches the output and checks that a first window appears, what it shows, and that the app stays alive.
const launch = async (appDir, variant, port) => {
    const executable = findExecutable(appDir);
    const before = appDataSnapshot();
    const child = spawn(executable, [`--remote-debugging-port=${port}`], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let exitCode = null;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => (exitCode = code));
    const started = Date.now();
    const report = { executable, firstWindowSeconds: null, pages: [], alive: false, screenshot: null };
    try {
        let pages = [];
        for (let i = 0; i < 90 && exitCode === null; i++) {
            await sleep(1000);
            pages = (await getJson(port, "/json/list").catch(() => [])).filter((target) => target.type === "page");
            if (pages.length > 0) break;
        }
        if (pages.length === 0) throw new Error(`no window appeared (exit=${exitCode})`);
        report.firstWindowSeconds = (Date.now() - started) / 1000;
        await sleep(waitSeconds * 1000);
        pages = (await getJson(port, "/json/list").catch(() => [])).filter((target) => target.type === "page");
        for (const page of pages.slice(0, 4)) {
            const view = await cdp(page.webSocketDebuggerUrl);
            const evaluated = await view.send("Runtime.evaluate", {
                expression:
                    "JSON.stringify({ title: document.title, textLength: document.body ? document.body.innerText.length : 0, elements: document.querySelectorAll('*').length })",
                returnByValue: true,
            });
            const info = JSON.parse(evaluated.result?.result?.value ?? "{}");
            report.pages.push({ url: page.url.slice(0, 160), ...info });
            if (!report.screenshot) {
                const shot = await view.send("Page.captureScreenshot", { format: "png" });
                if (shot.result?.data) {
                    report.screenshot = path.join(resultDir, `${variant}.png`);
                    fs.writeFileSync(report.screenshot, Buffer.from(shot.result.data, "base64"));
                }
            }
            view.close();
        }
        report.alive = exitCode === null;
    } catch (error) {
        report.error = String(error.message ?? error);
    } finally {
        if (exitCode === null) {
            try {
                execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            } catch {}
        }
        await sleep(1500);
        report.newAppDataDirs = [...appDataSnapshot()].filter((entry) => !before.has(entry));
        report.consoleErrors = output
            .split(/\r?\n/)
            .filter((line) => /error|cannot find module|uncaught/i.test(line))
            .slice(0, 10);
    }
    return report;
};

const main = async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
    const port = 9400 + ([...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 500);
    const result = {
        name,
        app,
        appVersion: pkg.version,
        electronBuilder: JSON.parse(
            fs.readFileSync(require.resolve("electron-builder/package.json", { paths: [app] }), "utf8"),
        ).version,
        builderArgs,
        slimArgs,
        date: new Date().toISOString(),
    };
    for (const variant of flag("skip-base") ? ["slim"] : ["base", "slim"]) {
        const build = flag("skip-build") ? { status: 0, out: path.join(resultDir, variant) } : runBuild(variant);
        const size = measure(build.out);
        const entry = { build, size };
        if (build.status === 0 && size.unpackedDir) {
            entry.smoke = smoke({
                appDir: size.unpackedDir,
                packages: packagedRootDependencies(app, size.unpackedDir),
                shipped: productionPackages(app),
            });
            entry.launch = await launch(size.unpackedDir, variant, port);
        }
        result[variant] = entry;
        log(
            `${variant}: installers ${size.installers.map((i) => `${i.file}=${i.bytes}`).join(", ") || "none"}, unpacked ${size.unpackedBytes}, ` +
                `smoke failures ${entry.smoke?.failed.length ?? "-"}, first window ${entry.launch?.firstWindowSeconds ?? "-"}s, alive ${entry.launch?.alive ?? "-"}`,
        );
    }
    fs.writeFileSync(path.join(resultDir, "result.json"), JSON.stringify(result, null, 2));
    log(`result: ${path.join(resultDir, "result.json")}`);
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
