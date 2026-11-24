# 계정 패널 (gh-accounts)

스페이스에서 쓰는 저장소마다 어떤 GitHub 계정을 쓸지 보고 고릅니다. 고른 계정은 [gh-account](../gh-account.md) 도구가 모든 터미널의 `gh` 명령, `git push` 인증, 커밋 작성자에 씁니다.

```text
 계정                                   ↻
 스페이스
  ▤ app-workspace              [ 여러 계정 ▾ ]
    example-org/*              [ acct-b    ▾ ]
      app                         acct-b
      tools                       acct-a · 규칙 example-org/tools
    acct-a/*                   [ 규칙 없음 ▾ ]
      notes                       매핑 없음 · gh 활성 계정
 기본 계정                     [ 없음      ▾ ]
 로그인된 계정
  ● acct-a                        gh 활성
  ● acct-b
 규칙
  1 example-org/tools  [acct-a ▾] ↑ ↓ ✕
  2 example-org/*      [acct-b ▾] ↑ ↓ ✕
  [ owner/* 또는 owner/repo ] [계정 ▾] 추가
```

*패널 모양을 글자로 그린 스케치입니다. 실제 화면은 Herdr 테마 색을 따릅니다.*

## 사용법

- **위치**: 오른쪽 패널(탭 줄의 `계정` 버튼)
- **맞는 사람**: 회사 계정과 개인 계정처럼 GitHub 계정을 여럿 쓰는 사람

### 스페이스

- 스페이스 폴더와, 그 스페이스 탭에 열린 터미널의 지금 폴더에서 github.com 원격이 있는 저장소를 찾습니다.
- 저장소를 주인(owner)별로 묶고, owner 마다 쓸 계정을 고릅니다. 고르면 `owner/*` 규칙을 만들거나 바꿉니다. `규칙 없음`을 고르면 그 규칙을 지웁니다.
- 저장소 줄에는 지금 실제로 쓰일 계정과 이유(기본 계정, 다른 규칙)를 보여 줍니다.
- 한 스페이스에 owner 가 둘 이상이면 스페이스 이름 옆에서 한 번에 고를 수 있습니다. 그 스페이스의 owner 마다 `owner/*` 규칙을 같은 계정으로 맞춥니다.
- 규칙은 스페이스가 아니라 owner 기준입니다. 같은 owner 저장소를 다른 스페이스에서 열어도 같은 계정을 씁니다.

### 기본 계정

규칙에 없는 저장소에 쓸 계정입니다. `없음`이면 gh 활성 계정을 그대로 씁니다.

### 로그인된 계정

gh 에 로그인된 github.com 계정입니다. 계정을 더하려면 터미널에서 `gh auth login`을 실행한 뒤 새로고침합니다.
이 패널은 gh 활성 계정을 바꾸지 않습니다.

### 규칙

- 위에서부터 먼저 맞는 규칙이 이깁니다. `owner/repo` 규칙은 `owner/*`보다 위에 두세요.
- `↑`·`↓`로 순서를 바꾸고, `✕`로 지웁니다.
- 아래 줄에 `owner/*`나 `owner/repo`를 적고 계정을 골라 `추가`하면 규칙을 더합니다. 같은 규칙이 있으면 계정만 바꿉니다.
- 로그인되지 않은 계정에 매핑돼 있으면 바꾼 뒤 `주의:` 안내를 보여 줍니다. 그 저장소의 `gh`·`git push`는 다른 계정으로 넘어가지 않고 실패합니다.

패널은 60초마다, 그리고 무언가 바꿀 때마다 다시 읽습니다. 터미널에서 `gh-account`로 바꾼 것도 같은 파일이라 함께 보입니다.

## 필요한 것

- 함께 설치되는 모드: `tabs-mine`
- [gh-account](../gh-account.md) 도구: `sh herdr/install.sh --gh-account`로 따로 설치합니다. 없으면 패널에 설치 안내만 보입니다.
- Node.js, gh 2.60 이상
- macOS·Linux. Windows는 gh-account 도구가 아직 지원하지 않습니다.

## 설치

추가 모드라 기본 설치에는 들어가지 않습니다.

```sh
sh herdr/install.sh --gh-account     # 도구 (저장소 안에서)
sh herdr/install.sh --add gh-accounts  # 패널
```

- 설치하면 오른쪽 패널에 `accounts-board`를 더하고, 탭 줄에 `계정` 버튼이 생깁니다.

빼는 방법과 다른 옵션은 [모드 골라 설치](../../herdr/README.md#모드-골라-설치)에 있습니다.

---

[← 모드 목록으로](../../herdr/README.md#모드)
