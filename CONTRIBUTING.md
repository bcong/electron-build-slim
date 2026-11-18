# 기여하기

이슈와 PR 모두 환영합니다. 한국어와 영어 모두 괜찮습니다. (Issues and pull requests are welcome, in Korean or English.)

## 원칙

이 도구는 **실행 속도와 기능에 영향을 주지 않는 범위에서만** 용량을 줄입니다. 새 정리 규칙을 제안할 때는 다음을 함께 보여 주세요.

- 그 파일이 실행 중에 쓰이지 않는다는 근거 (코드, 문서, 실험)
- 규칙을 적용한 빌드가 스모크 검사를 통과하고 실제로 실행된다는 결과
- 규칙이 기능에 영향을 줄 수 있다면 기본값이 아니라 `--slim-*` 옵션으로

## 개발

```bash
git clone https://github.com/bcong/electron-build-slim.git
cd electron-build-slim
npm test
```

의존성이 없는 순수 Node.js 코드입니다(Node.js 20.12 이상, 테스트는 22 이상). electron-builder는 이 도구를 쓰는 앱 쪽에서 불러옵니다.

실제 앱으로 확인하려면 앱 폴더에서 로컬 소스를 직접 실행합니다.

```bash
node /path/to/electron-build-slim/bin/electron-build-slim.cjs plan --win
node /path/to/electron-build-slim/bin/electron-build-slim.cjs --win --x64
```

## PR

- 하나의 PR에는 하나의 변경만 담습니다.
- 동작을 바꾸면 `test/`에 테스트를 추가하고 `CHANGELOG.md`의 `Unreleased`에 적습니다.
- 크기에 관한 주장에는 측정한 숫자(전·후 바이트, 측정 횟수)를 붙입니다.

## 배포

`main`에서 버전을 올리고 GitHub 릴리스를 만들면 `publish` 워크플로가 npm에 게시합니다(npm Trusted Publishing, provenance 포함).
