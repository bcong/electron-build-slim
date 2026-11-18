// 사용자의 electron-builder 설정은 그대로 두고, 그 위에 용량 관련 항목만 덧붙여 electron-builder를 실행한다.
// electron-builder는 넘긴 설정 객체를 디스크 설정과 deepAssign으로 합치며, 배열(files 등)은 뒤에 이어 붙는다.
// 사용: node run-builder.cjs <옵션 JSON> <electron-builder 인자...>   (bin/electron-build-slim.cjs가 호출한다)
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { analyze, targetsFromArgv } = require("../index.cjs");

const PLATFORM_KEYS = { win: "win", linux: "linux", mac: "mac" };
// 실행할 때마다 압축을 푸는 형식. 이 형식의 compression은 실행 속도에 영향을 주므로 건드리지 않는다.
const RUNTIME_DECOMPRESSED = /^(appimage|snap)$/i;
// Windows에서 WebGPU(Dawn D3D12)만 쓰는 셰이더 컴파일러. ANGLE(D3D11)은 d3dcompiler_47.dll을 쓴다.
const WEBGPU_ONLY_FILES = ["dxcompiler.dll", "dxil.dll"];

const fromProject = (root, id) => require(require.resolve(id, { paths: [root] }));

const targetNames = (config, platform) =>
    [config[PLATFORM_KEYS[platform]]?.target ?? []]
        .flat()
        .map((target) => (typeof target === "string" ? target : (target?.target ?? "")));

// 사용자 훅(함수 또는 모듈 경로)을 감싸서 먼저 실행한다.
const chainHook = (root, userHook, ours) => async (context) => {
    if (typeof userHook === "function") await userHook(context);
    else if (typeof userHook === "string") {
        const loaded = require(path.resolve(root, userHook));
        await (typeof loaded === "function" ? loaded : loaded.default)(context);
    }
    await ours(context);
};

/**
 * @param {{ level: "safe" | "standard" | "max", languages?: string[], stripWebgpu?: boolean, keep?: string[], entries?: string[] }} options
 */
const buildAdditions = ({ root, userConfig, targets, options }) => {
    const analysis = analyze({ root, targets, keep: options.keep, entries: options.entries });
    const additions = { files: analysis.files };

    const compression = userConfig.compression ?? "normal";
    if (options.level === "max") {
        additions.compression = "maximum";
    } else if (options.level === "standard" && compression === "store") {
        additions.compression = "normal";
    }
    // maximum은 Linux에서 AppImage를 xz로 만든다. 실행할 때마다 풀기 때문에 시작이 느려지므로 해당 플랫폼은 원래 값을 유지한다.
    if (additions.compression) {
        for (const platform of Object.keys(targets)) {
            const key = PLATFORM_KEYS[platform];
            const runtimeDecompressed =
                platform === "linux" &&
                (targetNames(userConfig, platform).length === 0 ||
                    targetNames(userConfig, platform).some((name) => RUNTIME_DECOMPRESSED.test(name)));
            if (runtimeDecompressed && userConfig[key]?.compression === undefined) {
                additions[key] = { ...additions[key], compression: compression === "store" ? "normal" : compression };
            }
        }
    }

    if (options.languages?.length) additions.electronLanguages = options.languages;
    if (options.stripWebgpu) {
        additions.afterExtract = chainHook(
            root,
            userConfig.afterExtract,
            async ({ appOutDir, electronPlatformName }) => {
                if (electronPlatformName !== "win32") return;
                for (const name of WEBGPU_ONLY_FILES) fs.rmSync(path.join(appOutDir, name), { force: true });
            },
        );
    }
    // electron-builder 26은 ELECTRON_CACHE 환경 변수를 읽지 않으므로 Electron zip 캐시 위치를 직접 넘긴다.
    if (process.env.ELECTRON_CACHE && userConfig.electronDownload?.cache == null) {
        additions.electronDownload = { cache: process.env.ELECTRON_CACHE };
    }
    return { additions, analysis };
};

// 종료 코드: 0 성공, 1 electron-builder 단계 실패(캐시 문제일 수 있어 재시도 대상), 2 이 도구의 준비 단계 실패.
let stage = "prepare";

const main = async () => {
    const root = process.cwd();
    const [optionsJson, ...builderArgs] = process.argv.slice(2);
    const options = JSON.parse(optionsJson);
    const builder = fromProject(root, "electron-builder/out/builder");
    const { getConfig } = fromProject(root, "app-builder-lib/out/util/config/config");

    const argv = builder.configureBuildCommand(builder.createYargs()).parse(builderArgs);
    const configPath = typeof argv.config === "string" ? argv.config : null;
    const cliOverrides = argv.config != null && typeof argv.config === "object" ? argv.config : {};
    // 읽기 전용: 기존 압축, 출력 폴더, 대상 형식, 훅을 확인하는 데만 쓴다.
    const userConfig = await getConfig(root, configPath, structuredClone(cliOverrides));
    const targets = targetsFromArgv(builderArgs);
    const { additions, analysis } = buildAdditions({ root, userConfig, targets, options });

    console.log(
        `[slim] 대상 ${Object.entries(targets)
            .map(([p, a]) => `${p}/${a.join(",")}`)
            .join(" ")}, 레벨 ${options.level}: ` +
            `의존성 ${analysis.keep.length}개 유지, ${analysis.drop.length}개 제외` +
            (analysis.undeclared.length ? ` (선언 없이 쓰는 의존성 포함: ${analysis.undeclared.join(", ")})` : ""),
    );
    if (process.env.SLIM_INFO_FILE) {
        fs.writeFileSync(
            process.env.SLIM_INFO_FILE,
            JSON.stringify({ outDir: userConfig.directories?.output ?? "dist", targets }),
        );
    }

    // 설정 파일 경로를 줬다면 extends로 그 파일을 읽게 한다(electron-builder가 "."이 든 extends를 configPath로 다룬다).
    const config = { ...cliOverrides, ...additions, ...(configPath ? { extends: configPath } : {}) };
    for (const key of Object.values(PLATFORM_KEYS)) {
        if (cliOverrides[key] && additions[key]) config[key] = { ...cliOverrides[key], ...additions[key] };
    }
    stage = "build";
    await builder.build({ ...argv, config });
};

main().catch((error) => {
    console.error(error);
    process.exitCode = stage === "build" ? 1 : 2;
});
