#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { analyze, targetsFromArgv } = require("../index.cjs");

const USAGE = `electron-build-slim: electron-builder 대신 쓰면 기존 설정 그대로 용량을 줄여 빌드합니다.

  electron-build-slim [electron-builder 인자...] [--slim-* 옵션]
      예) electron-build-slim --win --x64
          electron-build-slim --linux AppImage --arm64 --slim-level max

  --slim-level <safe|standard|max>  기본 standard
        safe      실행에 쓰지 않는 의존성·파일만 뺀다
        standard  safe + 설치 파일 압축이 store면 normal로 (설치 파일만 해당, 실행 속도와 무관)
        max       standard + 설치 파일 maximum 압축 (AppImage/snap처럼 실행할 때 푸는 형식은 제외)
  --slim-languages <ko,en-US>       Chromium 기본 UI 언어 팩만 남김 (기본: 모두 유지)
  --slim-strip-webgpu               Windows WebGPU 전용 DLL(dxcompiler, dxil) 제거 (WebGPU를 안 쓸 때만)
  --slim-keep <a,b>                 분석과 상관없이 넣을 의존성 (동적 require 등)
  --slim-entries <dir,dir>          앱 코드 위치 (기본: out/main+out/preload, 없으면 프로젝트 전체)
  --slim-no-smoke                   빌드 후 스모크 검사 생략

  electron-build-slim plan [대상 인자] [--slim-keep a,b]   넣고 뺄 패키지 미리 보기
  electron-build-slim report <app.asar> [개수]              asar 용량을 패키지별로 출력
  electron-build-slim smoke <win-unpacked 등> [패키지...]    스모크 검사만 실행

  install-app-deps 등 electron-builder의 다른 명령은 그대로 electron-builder로 넘깁니다.`;

const BUILDER_COMMANDS = new Set([
    "install-app-deps",
    "node-gyp-rebuild",
    "create-self-signed-cert",
    "start",
    "publish",
]);
const LEVELS = new Set(["safe", "standard", "max"]);

// --slim-* 옵션을 떼어 내고 나머지는 electron-builder 인자로 남긴다.
const splitArgs = (args) => {
    const slim = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
        const match = /^--slim-([a-z-]+)(?:=(.*))?$/.exec(args[i]);
        if (!match) {
            rest.push(args[i]);
            continue;
        }
        const [, key, inline] = match;
        const flag = key === "strip-webgpu" || key === "no-smoke";
        slim[key] = flag ? true : (inline ?? args[++i]);
    }
    return { slim, rest };
};
const list = (value) =>
    value
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean);

const slimOptions = (slim) => {
    const level = slim.level ?? "standard";
    if (!LEVELS.has(level)) throw new Error(`--slim-level은 safe, standard, max 중 하나입니다: ${level}`);
    return {
        level,
        languages: list(slim.languages),
        stripWebgpu: slim["strip-webgpu"] === true,
        keep: list(slim.keep),
        entries: list(slim.entries),
    };
};

const [command, ...others] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
} else if (BUILDER_COMMANDS.has(command)) {
    const cli = require.resolve("electron-builder/cli.js", { paths: [process.cwd()] });
    process.exitCode = spawnSync(process.execPath, [cli, command, ...others], { stdio: "inherit" }).status ?? 1;
} else if (command === "plan") {
    const { slim, rest } = splitArgs(others);
    const result = analyze({ targets: targetsFromArgv(rest), keep: list(slim.keep), entries: list(slim.entries) });
    console.log(`앱 코드 위치: ${result.entryDirs.join(", ")}`);
    console.log(`앱이 쓰는 의존성 (${result.entries.length}): ${result.entries.join(", ")}`);
    console.log(`선언 없이 require되는 의존성 (${result.undeclared.length}): ${result.undeclared.join(", ")}`);
    console.log(`포함 (${result.keep.length}): ${result.keep.join(", ")}`);
    console.log(`제외 (${result.drop.length}): ${result.drop.join(", ")}`);
    console.log(`소스 전용 폴더 제외 (${result.sourceOnly.length}): ${result.sourceOnly.join(", ")}`);
    console.log(
        `다른 OS/아키텍처용 prebuilds 제외 (${result.prebuilds.length})${result.prebuilds.length ? `\n  ${result.prebuilds.join("\n  ")}` : ""}`,
    );
} else if (command === "report") {
    const { asarSizes } = require("../lib/report.cjs");
    const [file, count = "30"] = others;
    if (!file) throw new Error(USAGE);
    const mb = (bytes) => (bytes / 1048576).toFixed(2).padStart(8);
    for (const row of asarSizes(file).slice(0, Number(count)))
        console.log(`${mb(row.packed + row.unpacked)} MB  (unpacked ${mb(row.unpacked)} MB)  ${row.name}`);
} else if (command === "smoke") {
    const { smoke } = require("../lib/smoke.cjs");
    const { packagedRootDependencies } = require("../lib/build.cjs");
    const [appDir, ...packages] = others;
    if (!appDir) throw new Error(USAGE);
    const names = packages.length > 0 ? packages : packagedRootDependencies(process.cwd(), path.resolve(appDir));
    const result = smoke({ appDir, packages: names });
    console.log(`통과 ${result.ok.length}, 실패 ${result.failed.length}, 경고 ${result.warnings.length}`);
    for (const line of [...result.failed.map((l) => `실패 ${l}`), ...result.warnings.map((l) => `경고 ${l}`)])
        console.log(`  ${line}`);
    process.exitCode = result.failed.length > 0 ? 1 : 0;
} else {
    const { build } = require("../lib/build.cjs");
    const args = command === "build" ? others : process.argv.slice(2);
    const { slim, rest } = splitArgs(args);
    process.exitCode = build({ builderArgs: rest, smokeCheck: slim["no-smoke"] !== true, slim: slimOptions(slim) });
}
