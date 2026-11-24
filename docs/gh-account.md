# 저장소별 GitHub 계정 (gh-account)

gh에 계정을 여러 개 로그인해 두고, 저장소 주인(owner)마다 쓸 계정을 정합니다.
정한 계정은 그 저장소에서 쓰는 `gh` 명령(PR, 이슈, 머지), `git push`·`git pull`의 HTTPS 인증, 커밋 작성자(이름·이메일)에 함께 쓰입니다.

- gh 활성 계정은 바꾸지 않습니다(`gh auth switch`를 쓰지 않습니다).
  - 예외는 [계정 패널](mods/gh-accounts.md)의 `계정 추가` 하나입니다. `gh auth login`은 새 계정을 활성으로 바꾸므로, 로그인이 끝나면 원래 활성 계정으로 한 번 되돌립니다.
- 토큰은 어디에도 저장하지 않습니다. 쓸 때마다 `gh auth token --user <계정>`으로 받습니다.
- Herdr 모드가 아니라서 Herdr 레이아웃과 상관없이 모든 터미널에서 쓰입니다.

## 설치

```sh
# 저장소 안에서
sh herdr/install.sh --gh-account
# 제거
sh herdr/install.sh --gh-account-uninstall
```

[계정 패널](mods/gh-accounts.md)의 `설치…`·`원래대로 되돌리기…` 버튼도 같은 일을 합니다. 누르면 바뀔 것을 먼저 보여 주고, 확인해야 실행합니다.

설치하면 다음이 생깁니다.

| 위치 | 하는 일 |
| --- | --- |
| `~/.local/bin/gh` | 얇은 래퍼. 저장소에 맞는 계정 토큰을 `GH_TOKEN`으로 넘기고 진짜 `gh`를 실행합니다. |
| `~/.local/bin/git-credential-gh-account` | git 자격 증명 도우미. github.com HTTPS 인증에 그 계정 토큰을 줍니다. |
| `~/.local/bin/gh-account` | 매핑을 보고 바꾸는 명령 |
| git 전역 설정의 `gh-account managed block` | 위 도우미 등록과 계정별 커밋 신원 `includeIf` |

- 설치 폴더는 `--bin <폴더>`나 `GH_ACCOUNT_BIN`으로 바꿀 수 있습니다.
- `~/.local/bin`이 PATH에서 진짜 `gh`보다 앞에 있어야 래퍼가 쓰입니다. 아니면 설치할 때 알려 줍니다.
- 그 자리에 이 도구가 만들지 않은 파일이 있으면 덮어쓰지 않고 멈춥니다.
- 원래 있던 자격 증명 도우미(예: macOS 키체인)는 이 도구가 감싸서 그 뒤에 둡니다. 매핑이 없는 저장소는 원래대로 인증합니다.
  - 매핑 계정 토큰은 원래 도우미에 저장하지 않습니다. push 가 성공해도 키체인 등에 토큰이 남지 않습니다.
  - 원래 도우미에는 저장소 경로(`path`)를 넘기지 않습니다. 설치 전과 같은 모양으로 읽고 저장합니다.
- 설치할 때 찾은 진짜 `gh` 경로를 기록해 둡니다. 나중에 PATH 가 짧은 곳(GUI 앱, 예약 작업)에서 실행돼도 그 `gh`를 씁니다.

## 사용법

```sh
gh auth login                        # 쓸 계정마다 한 번씩 로그인
gh-account list                      # 로그인된 계정과 매핑 규칙 보기
gh-account set example-org/* acct-b  # example-org 저장소는 acct-b
gh-account set acct-a/special acct-b # 저장소 하나만 따로
gh-account default acct-a            # 규칙에 없는 저장소 (none 으로 끔)
gh-account resolve                   # 지금 폴더에서 쓸 계정
gh-account resolve -R example-org/app
gh-account unset example-org/*
gh-account move example-org/app up    # 규칙 순서 한 칸 위로 (위가 먼저 맞음)
gh-account status                    # 설치·PATH·git 버전 점검
```

`gh-account list`는 실제 계정 이름을 보여 줍니다. 결과를 이슈나 채팅에 붙일 때는 계정 이름을 가리세요.

매핑은 `<설정 폴더>/gh-accounts.json`에 저장됩니다(`<설정 폴더>`는 `HERDR_APP_HOME`, 없으면 `~/.config/herdr-app`).

```json
{
  "rules": [
    { "match": "example-org/*", "account": "acct-b" },
    { "match": "acct-a/special", "account": "acct-b" }
  ],
  "default": null
}
```

- 규칙은 위에서부터 보고, 먼저 맞는 규칙이 이깁니다. 맞는 규칙이 없으면 `default`를 씁니다.
- `match`는 `owner/*`나 `owner/repo` 모양입니다.

### 계정 패널

Herdr 오른쪽 패널에서 스페이스의 저장소마다 쓸 계정을 보고 고를 수 있습니다. 같은 매핑 파일을 바꿉니다.

```sh
sh herdr/install.sh --add gh-accounts
```

- 스페이스의 owner 마다 계정을 고르면 `owner/*` 규칙을 만듭니다. 규칙 순서 바꾸기·지우기·더하기와 기본 계정도 패널에서 합니다.
- 도구 설치·되돌리기, 저장소마다 쓸 계정 확인과 접속 시험, 계정 추가(gh 로그인)도 패널에서 합니다.
- 자세한 내용: [gh-accounts](mods/gh-accounts.md)

스크립트에서 쓰는 명령:

```sh
gh-account space --json <폴더..>          # 폴더들의 저장소를 owner 별로 묶고 쓸 계정을 보여 줌
gh-account assign acct-b <폴더..> [--json]
                                          # 그 폴더들 저장소의 owner 마다 owner/* 규칙을 acct-b 로 (none 이면 지움)
                                          # 로그인된 계정과 같은 owner(개인 저장소일 수 있음)는 건너뛰고 알려 줌
gh-account check [폴더 | -R owner/repo] [--test] [--json]
                                          # gh 명령·git push·커밋 신원이 쓸 계정. --test 는 그 계정으로 저장소 권한을 읽어 봄
gh-account status --json                  # 설치 상태
gh-account install --dry-run [--json]     # 설치하면 바뀔 것만 보여 줌 (쓰지 않음)
gh-account uninstall --dry-run [--json]   # 되돌리면 바뀔 것만 보여 줌
gh-account login start|status|cancel [--json]
                                          # 계정 추가: 뒤에서 gh auth login --web 을 돌리고 일회용 코드를 알려 줌
gh-account shell-path                     # 로그인 셸의 PATH (GUI 앱에서 gh·git 을 찾을 때)
```

- `check`·`--test`는 토큰을 보여 주지 않습니다. `--test`는 그 계정 토큰을 `GH_TOKEN`으로 넘겨 `gh api`를 부를 뿐입니다.
- `login start`는 시작할 때의 활성 계정을 기억합니다. 로그인이 성공해 활성 계정이 바뀌었으면 `gh auth switch`로 한 번 되돌리고, 실패·취소·시간 초과(15분)면 아무것도 바꾸지 않습니다. 진행 상태는 `<설정 폴더>/gh-account/login.json`에 있고, 토큰처럼 보이는 문자열은 가려서 적습니다.

### 커밋 신원

매핑된 계정마다 커밋 이름·이메일을 정합니다.

- 기본값은 그 계정의 GitHub 이름(없으면 로그인 이름)과 noreply 주소(`<id>+<login>@users.noreply.github.com`)입니다.
- 저장소에 직접 정한 `user.name`·`user.email`이 있으면 그 값이 이깁니다.
- git 2.36 이상이 필요합니다. 낮으면 신원만 건너뛰고 인증은 그대로 됩니다.

```sh
gh-account identity acct-b --name "Person B" --email user@example.com
gh-account identity acct-b --auto   # 다시 기본값으로
gh-account identity acct-b --off    # 이 계정은 커밋 신원을 바꾸지 않음
```

## 어떻게 저장소를 알아내나

| 쓰는 곳 | 저장소를 정하는 순서 |
| --- | --- |
| `gh` 래퍼 | `-R`/`--repo` → 인자의 GitHub URL → `gh repo clone o/r` 같은 위치 인자 → `gh api repos/o/r/...` → `GH_REPO` → 지금 폴더의 원격 |
| git 자격 증명 도우미 | 요청 URL 의 저장소(`path`) → 지금 저장소의 원격 |
| 커밋 신원 | 저장소 원격 URL(`includeIf "hasconfig:remote.*.url:..."`) |

- 지금 폴더의 원격은 `origin`, 없으면 github.com을 가리키는 첫 원격입니다.
- 설치하면 github.com 에 `credential.useHttpPath`를 켜서 git 이 요청 URL 의 저장소를 넘기게 합니다. 그래서 `origin`이 아닌 원격으로 push 해도 그 원격 주인의 계정을 씁니다.
- `git clone`도 새 저장소의 `origin`으로 계정을 고릅니다.

## 안전 장치

- 매핑 파일이 없거나 깨졌거나 맞는 규칙이 없으면 아무 일도 하지 않습니다. `gh`와 `git`은 원래대로 동작합니다.
- 매핑된 계정이 gh에 로그인돼 있지 않으면 다른 계정으로 넘어가지 않고 실패합니다. 메시지에 로그인·매핑 지우기 방법을 함께 보여 줍니다.
- `GH_TOKEN`이나 `GITHUB_TOKEN`이 이미 있으면 래퍼는 건드리지 않습니다.
- 저장소와 상관없는 명령(`gh auth`, `gh --version`, `gh help`, `gh config`, `gh extension`, `gh alias`, `gh completion`)은 매핑을 보지 않고 그대로 진짜 `gh`로 넘깁니다.
- 진짜 `gh`를 찾지 못하면 git 자격 증명 도우미는 실패하지 않고 원래 도우미로 넘깁니다. 이때 다시 설치하라는 안내를 보여 줍니다.
- 잠깐 끄려면 `GH_ACCOUNT_OFF=1`을 붙입니다.

## 한계

- HTTPS 원격만 인증합니다. SSH 원격(`git@github.com:...`)의 push 인증은 SSH 키를 따릅니다. 커밋 신원은 SSH 원격에도 적용됩니다.
- github.com만 다룹니다. GitHub Enterprise(`GH_HOST`)에서는 래퍼가 그대로 넘깁니다.
- 커밋 신원의 URL 비교는 대소문자를 가립니다. 원격 URL의 owner 철자를 규칙과 같게 적으세요.
- 원격이 여럿이고 서로 다른 계정에 맞으면, 커밋 신원은 git 설정에서 나중에 오는 규칙(목록에서 앞 규칙)이 이깁니다.
- 설치 뒤에 `gh auth setup-git` 등으로 자격 증명 도우미를 바꿨다면 `sh herdr/install.sh --gh-account`를 다시 실행하세요.
- Windows는 아직 지원하지 않습니다.

[Herdr 모드 문서로 돌아가기](../herdr/README.md)
