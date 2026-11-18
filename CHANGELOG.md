# Changelog

이 프로젝트는 [Semantic Versioning](https://semver.org/lang/ko/)을 따릅니다.

## [Unreleased]

### 고침

- `--config <파일>`과 `-c.x=y`를 함께 주면 설정이 배열로 넘어와 덧붙이는 항목이 무시되던 문제.
- 설정 로더(`getConfig`) 위치가 다른 electron-builder 버전에서 실패하던 문제.
- pnpm처럼 `node_modules/<이름>`이 링크인 구조에서 하위 의존성을 찾지 못하던 문제. 이제 실제 경로 기준으로 찾습니다.

## [0.1.0] - 2026-11-18

첫 공개 버전.

- `electron-builder` 명령 대신 쓰는 CLI. 기존 설정을 그대로 읽고 `files` 제외 패턴과 압축 설정만 덧붙인다.
- 앱 코드가 실제로 불러오는 의존성만 남기는 분석(`analyze`, `pruneFiles`).
- 빌드 후 스모크 검사, 빌드 실패 시 빌드 도구 캐시를 비우고 한 번 재시도.
- `@electron/packager`/electron-forge용 `packagerIgnore()`.
- `plan`, `report`, `smoke` 명령.

[Unreleased]: https://github.com/bcong/electron-build-slim/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bcong/electron-build-slim/releases/tag/v0.1.0
