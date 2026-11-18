# electron-build-slim

Electron 앱 설치 파일에서 **실행에 쓰지 않는 파일만** 빼는 도구입니다. 기존 electron-builder 설정은 그대로 두고 명령 이름만 바꿔서 씁니다.

> **English:** A drop-in replacement for the `electron-builder` command. It keeps your existing config, ships only the `node_modules` your app actually loads, checks the packaged app can still load them, and retries once with a fresh tool cache if the build fails. It never changes anything that affects startup speed or behavior unless you opt in.

```bash
npm i -D electron-build-slim
npx electron-build-slim --win          # electron-builder --win 대신
```

## 무엇을 줄이나

| 줄이는 것 | 기본 | 실행 속도·기능 영향 |
|---|---|---|
| 앱 코드가 불러오지 않는 의존성(`electron` npm 패키지, `node-gyp`, 렌더러에 번들된 `react` 등) | 켜짐 | 없음. 빌드 후 스모크 검사로 확인 |
| 의존성 안의 문서·테스트·C++ 소스·빌드 중간 파일 | 켜짐 | 없음 |
| 다른 OS/아키텍처용 네이티브 바이너리(`prebuilds/<os>-<arch>`) | 켜짐 | 없음 |
| 설치 파일 압축 `store` → `normal` | 켜짐 (`standard`) | 없음. 설치할 때 한 번 풀린다 |
| Chromium 기본 UI 언어 팩 (`--slim-languages`) | 꺼짐 | 메뉴·대화상자 같은 Chromium 기본 문구 언어가 줄어든다 |
| Windows WebGPU 전용 DLL (`--slim-strip-webgpu`) | 꺼짐 | WebGPU를 쓰면 안 된다 |

**하지 않는 것:** AppImage·snap처럼 실행할 때마다 압축을 푸는 형식의 압축 방식 변경(실행이 느려짐), `asar` 끄기, UPX, swiftshader·`icudtl.dat`·`*.pak` 같은 Chromium 런타임 파일 삭제.

얼마나 줄어드는지는 앱마다 다릅니다. 의존성이 많고 잘못 들어간 패키지가 큰 앱은 많이 줄고, 의존성이 거의 없는 앱은 거의 그대로입니다.

흔한 원인은 `@electron-toolkit/*` 같은 패키지의 peer 의존성 때문에 `electron` npm 패키지(Windows 기준 압축 전 약 340 MB)가 앱 안에 한 벌 더 들어가는 경우입니다.

## 설치

```bash
npm i -D electron-build-slim
# yarn add -D electron-build-slim
# pnpm add -D electron-build-slim
```

Node.js 20.12 이상, electron-builder 26 이상에서 확인했습니다.

## 사용법

### electron-builder (권장)

`package.json`의 `build`, `electron-builder.yml`, `electron-builder.config.js` 등 기존 설정은 그대로 둡니다. 스크립트에서 `electron-builder`만 `electron-build-slim`으로 바꿉니다.

```json
{
    "scripts": {
        "dist:win": "electron-vite build && electron-build-slim --win",
        "dist:linux": "electron-vite build && electron-build-slim --linux AppImage --arm64"
    }
}
```

electron-builder 인자는 모두 그대로 넘어갑니다(`--config`, `--dir`, `--publish`, `-c.xxx=yyy` 등). `--publish`를 주지 않으면 `--publish never`가 붙습니다. `install-app-deps` 같은 다른 명령도 그대로 electron-builder로 넘어갑니다.

도구는 기존 설정을 바꾸지 않고, 그 위에 `files` 제외 패턴과 압축 같은 몇 가지 항목을 덧붙여 electron-builder를 실행합니다. 설정의 훅(`afterPack` 등)도 그대로 동작합니다.

### 옵션

| 옵션 | 설명 |
|---|---|
| `--slim-level <safe\|standard\|max>` | 기본 `standard`. 아래 표 참고 |
| `--slim-languages ko,en-US` | Chromium 기본 UI 언어 팩만 남긴다 (electron-builder `electronLanguages`) |
| `--slim-strip-webgpu` | Windows에서 `dxcompiler.dll`, `dxil.dll` 제거. 앱이 WebGPU를 쓰지 않을 때만 |
| `--slim-keep a,b` | 분석과 상관없이 반드시 넣을 의존성. `require(name)`처럼 모듈 이름을 변수로 만들 때 |
| `--slim-entries dir1,dir2` | 앱 코드 위치. 기본은 `out/main`+`out/preload`(electron-vite), 없으면 `node_modules`를 뺀 프로젝트 전체 |
| `--slim-no-smoke` | 빌드 후 스모크 검사 생략 |

| 레벨 | 하는 일 |
|---|---|
| `safe` | 실행에 쓰지 않는 의존성·파일만 뺀다. 설정은 그대로 |
| `standard` | `safe` + 설치 파일 압축이 `store`면 `normal`로 |
| `max` | `standard` + `compression: maximum`. Linux는 AppImage가 xz가 되어 실행이 느려지므로 기존 값 유지 |

NSIS 설치 파일은 7z로 묶이는데, electron-builder 26에서는 `normal`과 `maximum`이 같은 7z 압축 수준(`-mx=9`)을 씁니다. 그래서 NSIS만 만든다면 `max`와 `standard`의 결과가 사실상 같습니다. `max`는 zip 같은 다른 형식에서 차이가 납니다.

### 빌드 후 스모크 검사

빌드가 끝나면 결과물의 Electron 런타임(`ELECTRON_RUN_AS_NODE`)으로 앱 `package.json`의 의존성 중 결과물에 들어간 것을 하나씩 `require`해 봅니다. 파일이 빠져서 나는 오류(`Cannot find module`, `Could not locate the bindings file`, `No native build was found`)가 있으면 빌드를 실패로 끝냅니다.

- `Cannot find module 'electron'`은 경고만 남깁니다. 실제 실행 때는 내장 모듈이기 때문입니다.
- 다른 OS 전용 네이티브 모듈의 로드 오류(예: Windows에서 Linux 전용 모듈)도 경고만 남깁니다.
- 이 PC와 같은 OS/아키텍처 결과물에서만 돕니다. Windows에서 Linux용을 만들면 건너뜁니다. macOS 결과물은 아직 검사하지 않습니다.

### 빌드 도구 캐시와 재시도

electron-builder 단계에서 빌드가 실패하면 Electron zip 캐시와 electron-builder 도구 캐시(NSIS, AppImage 도구 등)를 비우고 다시 받아 한 번 더 빌드합니다. 설정을 읽거나 분석하는 단계의 실패는 캐시와 무관하므로 재시도하지 않습니다.

캐시 위치는 `ELECTRON_CACHE`, `ELECTRON_BUILDER_CACHE` 환경 변수로 바꿀 수 있습니다. electron-builder 26은 `ELECTRON_CACHE`를 직접 읽지 않으므로, 설정에 `electronDownload.cache`가 없으면 도구가 이 값을 넘깁니다.

### 다른 명령

```bash
npx electron-build-slim plan --win --x64               # 무엇을 넣고 뺄지 미리 보기
npx electron-build-slim report dist/win-unpacked/resources/app.asar   # asar 안 용량을 패키지별로
npx electron-build-slim smoke dist/win-unpacked        # 스모크 검사만
```

적용 전에 `report`로 어디가 큰지 먼저 보는 것을 권합니다. `node_modules/electron`, `node-gyp`, `tar`, 렌더러에서 쓰는 `react` 같은 이름이 보이면 이 도구로 줄일 수 있습니다.

### @electron/packager, electron-forge

`packagerIgnore()`는 packager `ignore`에 넣을 정규식 배열을 돌려줍니다. 배열로 넘기면 packager의 기본 제외 규칙도 유지됩니다(함수로 넘기면 packager가 기본 규칙을 쓰지 않습니다).

```js
// forge.config.js
const { packagerIgnore } = require("electron-build-slim");

module.exports = {
    packagerConfig: {
        asar: true,
        ignore: [/^\/out($|\/)/, ...packagerIgnore({ targets: { win: ["x64"] } })],
    },
};
```

- `targets`를 생략하면 지금 PC의 OS/아키텍처 기준입니다.
- @electron/packager로 직접 패키징해서 확인했습니다. electron-forge 프로젝트에서는 아직 검증하지 않았습니다.
- forge의 Vite/Webpack 플러그인은 `ignore`를 자체 함수로 정하므로 이 방식이 적용되지 않습니다.
- 스모크 검사는 `npx electron-build-slim smoke <패키징 폴더>`로 따로 돌립니다.

### API

```js
const { analyze, pruneFiles, packagerIgnore } = require("electron-build-slim");

analyze({ root, targets: { win: ["x64"] }, keep: [], entries: undefined, neverShip: [] });
// → { entries, undeclared, keep, drop, sourceOnly, prebuilds, files }

pruneFiles(); // electron-builder `files`에 이어 붙일 제외 패턴 (대상은 CLI 인자에서 읽음)
```

명령을 바꾸고 싶지 않다면 electron-builder JS 설정에서 직접 써도 됩니다.

```js
// electron-builder.config.js
const { pruneFiles } = require("electron-build-slim");
module.exports = { files: ["out/**/*", ...pruneFiles()] /* ...기존 설정 */ };
```

이 경우 스모크 검사와 캐시 재시도는 동작하지 않습니다.

## GitHub Actions에서 캐시 쓰기

빌드에 성공했을 때만 캐시를 저장합니다. 빌드 중에 캐시를 비우고 다시 받았으면 도구가 `tool-cache-refreshed=true`를 출력하므로, 기존 항목을 지우고 새로 저장합니다.

```yaml
permissions:
  contents: read
  actions: write # 손상된 캐시 삭제용

steps:
  - name: Set tool cache paths
    shell: bash
    run: |
      echo "TOOLS_CACHE_KEY=tools-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json', 'yarn.lock') }}" >> "$GITHUB_ENV"
      echo "ELECTRON_CACHE=$RUNNER_TEMP/electron-cache" >> "$GITHUB_ENV"
      echo "ELECTRON_BUILDER_CACHE=$RUNNER_TEMP/electron-builder-cache" >> "$GITHUB_ENV"

  - name: Restore build tool cache
    id: tools
    uses: actions/cache/restore@v4
    with:
      path: |
        ${{ env.ELECTRON_CACHE }}
        ${{ env.ELECTRON_BUILDER_CACHE }}
      key: ${{ env.TOOLS_CACHE_KEY }}
      restore-keys: tools-${{ runner.os }}-${{ runner.arch }}-

  - name: Build
    id: build
    run: npx electron-build-slim --linux AppImage

  - name: Drop stale build tool cache
    if: steps.tools.outputs.cache-hit == 'true' && steps.build.outputs.tool-cache-refreshed == 'true'
    env:
      GH_TOKEN: ${{ github.token }}
    run: gh cache delete "$TOOLS_CACHE_KEY" --repo "$GITHUB_REPOSITORY" || true

  - name: Save build tool cache
    if: steps.tools.outputs.cache-hit != 'true' || steps.build.outputs.tool-cache-refreshed == 'true'
    uses: actions/cache/save@v4
    with:
      path: |
        ${{ env.ELECTRON_CACHE }}
        ${{ env.ELECTRON_BUILDER_CACHE }}
      key: ${{ env.TOOLS_CACHE_KEY }}
```

## 동작 방식

1. 루트 `dependencies` 중 앱 코드에 이름이 나오는 패키지를 찾습니다. 메인이 V8 바이트코드(`.jsc`)여도 모듈 이름은 문자열 상수로 남아서 찾을 수 있습니다.
2. 그 패키지들의 `dependencies`, `optionalDependencies`를 따라갑니다. `peerDependencies`는 따라가지 않습니다(`electron`을 끌어오는 주범). `@types/*`와 빌드 전용 패키지(`node-gyp`, `prebuild-install`, `nan`, `node-addon-api`, `patch-package` 등)는 뺍니다.
3. 포함된 패키지의 코드가 선언 없이 `require`하는 루트 의존성을 찾아 넣습니다. 패치된 패키지에서 흔합니다. 더 늘지 않을 때까지 반복합니다.
4. electron-builder가 넣을 수 있는 패키지 전체에서 위 결과를 뺀 나머지를 제외 패턴으로 만듭니다.
5. 포함된 패키지 안에서도 다른 OS/아키텍처의 `prebuilds`, 실행 파일이 없는 `src`·`deps` 폴더, 문서·테스트·C++ 소스를 뺍니다.

## 한계

- **분석은 문자열 기반입니다.** 모듈 이름을 변수로 만들어 `require`하면 찾지 못하니 `--slim-keep`에 넣습니다. 스모크 검사는 패키지를 처음 불러올 때 빠진 파일만 잡습니다. 실행 중에 늦게 불러오는 경로는 앱을 실제로 써 봐야 확인됩니다.
- **번들러 없이 소스를 그대로 패키징하는 앱**은 프로젝트 전체의 JS를 앱 코드로 봅니다. 그래서 렌더러에서만 쓰는 의존성도 남을 수 있습니다. 필요한 모듈을 빼지는 않는 쪽으로 틀립니다.
- **렌더러는 검사하지 않습니다.** `nodeIntegration`으로 렌더러가 node 모듈을 직접 부르면 그 모듈을 `--slim-keep`에 넣습니다.
- **패키지 매니저:** npm과 yarn(`node_modules` 방식)에서 확인했습니다. Yarn PnP는 지원하지 않고, pnpm은 확인하지 않았습니다.
- **macOS:** 분석과 제외는 같지만 빌드와 스모크 검사를 macOS에서 확인하지 않았습니다.

## 라이선스

[MIT](LICENSE). 포크, 수정, 재배포, 상업적 이용을 포함해 어떤 용도로든 자유롭게 쓰고 고칠 수 있습니다. 라이선스 고지(LICENSE 파일)만 함께 남겨 주세요.
