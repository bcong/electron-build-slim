---
name: electron-build-slim
description: Electron 앱의 설치 파일·AppImage 용량을 실행 속도와 기능에 영향 없이 줄일 때 쓴다. 설치 파일이 크다, win-unpacked/linux-unpacked가 크다, node_modules가 통째로 들어간다, electron-builder 빌드 도구 캐시가 깨진다, CI 빌드 캐시 같은 요청에 적용한다.
---

# Electron 빌드 용량 줄이기

도구는 npm 패키지 `electron-build-slim`이다(README 참고). 순서대로 하고, 각 단계의 숫자와 출력을 근거로 남긴다.

## 1. 기준을 잰다

1. 현재 설정 그대로 한 번 빌드한다. 설치 파일 크기(바이트), `*-unpacked` 크기, 패키징 시간을 적는다.
2. `npx electron-build-slim report <unpacked>/resources/app.asar 30`으로 무엇이 큰지 본다. `node_modules/electron`, `node-gyp`, `tar`, 렌더러용 `react` 같은 이름이 보이면 줄일 수 있다.
3. 크기는 매번 같으므로 1회 측정으로 충분하다. 시간은 1회면 1회라고 적는다.

## 2. 적용한다

1. `npm i -D electron-build-slim`을 설치하고 빌드 스크립트의 `electron-builder`를 `electron-build-slim`으로 바꾼다. 기존 설정은 건드리지 않는다.
2. `npx electron-build-slim plan --win`(또는 `--linux --arm64`)으로 넣을 것과 뺄 것을 확인한다. 앱 기능이 쓰는 패키지가 "제외"에 있으면 원인을 찾는다. 모듈 이름을 변수로 만들어 `require`하는 경우라면 `--slim-keep`에 넣는다.
3. 기본 레벨(`standard`)로 시작한다. 언어 팩 제거(`--slim-languages`)와 WebGPU DLL 제거(`--slim-strip-webgpu`)는 기능에 영향을 줄 수 있으니 사용자에게 확인된 경우에만 켠다.

## 3. 결과물로 검증한다

빌드가 성공했다는 것만으로는 끝이 아니다.

1. 빌드 끝의 스모크 검사 결과를 읽는다. "실패"는 반드시 고친다. "경고" 중 `Cannot find module 'electron'`과 다른 OS 전용 모듈의 로드 오류는 정상이다. 적용 전 빌드에도 같은 경고가 나는지 `smoke` 명령으로 비교한다.
2. 패키징된 앱을 실제로 실행해 첫 화면이 뜨는지 본다. 원격 디버깅 포트(`--remote-debugging-port`)와 CDP로 화면 텍스트와 스크린샷을 남기면 다시 확인할 수 있다.
3. 실행하기 전에 앱이 시작할 때 시스템을 바꾸는지 확인한다. 예를 들어 시작 프로그램 등록이나 서비스 설치가 있다. 그런 동작은 환경 변수 등으로 끄고 실행한다.
4. 크기와 시간을 기준과 같은 방식으로 다시 재서 비교표를 만든다.

## 4. 캐시 재시도를 검증한다

사용자의 실제 캐시를 건드리지 않도록 `ELECTRON_CACHE`, `ELECTRON_BUILDER_CACHE`를 임시 폴더로 지정하고 확인한다.

1. 빈 캐시로 빌드한다. 캐시 폴더에 Electron zip과 NSIS/AppImage 도구가 생겨야 한다.
2. 압축이 풀린 도구(예: `nsis-*/Bin/makensis.exe`)를 쓰레기 바이트로 덮어쓰고 빌드한다. 1차 실패, 캐시 삭제, 2차 성공이 나와야 한다.
3. Electron zip을 망가뜨리면 다운로더가 체크섬으로 알아서 다시 받는다. 재시도 경로를 시험하는 데는 쓸 수 없다.

## 하지 않는 것

- AppImage·snap의 압축을 xz 등으로 바꾸기. 실행할 때마다 압축을 풀어서 느린 기기(예: Raspberry Pi)에서 시작이 크게 늦어진다.
- `vk_swiftshader*`, `libEGL`, `libGLESv2`, `icudtl.dat`, `*.pak`, `snapshot_blob.bin`, `v8_context_snapshot.bin`, `ffmpeg` 삭제.
- `LICENSES.chromium.html` 삭제. Chromium 라이선스 고지다.
- UPX 압축, `asar: false`.
- 검증 없이 제외 규칙을 넓히기. 넓혔으면 스모크 검사와 실제 실행으로 다시 확인한다.
