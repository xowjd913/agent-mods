# Herdr 모드

터미널 작업 공간 앱 [Herdr](https://github.com/herdrdev/herdr)용 모드의 설치와 동작 방식을 설명합니다.
소개와 빠른 설치는 [저장소 첫 화면](../README.md)에 있습니다.

![탭 줄 오른쪽의 Files·Changes·Work·PRs·예약 버튼과, 예약 패널을 연 화면](../docs/images/herdr-overview.png)

*설치 직후 데모 저장소에서 `예약` 패널을 연 화면*

## 목차

- [모드](#모드)
- [설치](#설치)
  - [필요한 것](#필요한-것)
  - [설치 명령](#설치-명령)
  - [모드 골라 설치](#모드-골라-설치)
- [업데이트와 제거](#업데이트와-제거)
- [동작 방식](#동작-방식)
- [데이터가 저장되는 곳](#데이터가-저장되는-곳)

---

## 모드

모드마다 문서 한 장에 사용법, 필요한 것, 설치 방법을 같은 순서로 적었습니다.

| 모드 | 한 줄 | 기본/추가 | 문서 |
| --- | --- | --- | --- |
| 패널 버튼 (`tabs-mine`) | 탭 줄에 Work·PRs·예약 버튼을 붙이고, 손봐야 할 PR 수를 띄웁니다 | 기본 | [tabs-mine](../docs/mods/tabs-mine.md) |
| Work (`work`) | 세션마다 맡은 이슈, 워크트리, PR, CI를 한 트리로 봅니다 | 기본 | [work](../docs/mods/work.md) |
| PRs (`prs`) | 저장소별 열린 PR과 리뷰 상태, 정리할 워크트리를 봅니다 | 기본 | [prs](../docs/mods/prs.md) |
| 예약 (`schedules`) | 정해진 시각에 Claude나 Codex 세션을 띄워 프롬프트를 보냅니다 | 기본 | [schedules](../docs/mods/schedules.md) |
| 워크트리 메뉴 (`wt-menu`) | 워크트리를 IDE, Herdr 공간, Finder·탐색기, GitHub로 바로 엽니다 | 기본 | [wt-menu](../docs/mods/wt-menu.md) |
| Claude 사용률 (`usage-status`) | 아래 상태 줄에 Claude 5시간·7일 사용률을 막대로 보여 줍니다 | 추가 | [usage-status](../docs/mods/usage-status.md) |
| 작업별 묶음 (`agent-groups`) | 사이드바에서 터미널을 리더별로 묶고 리더 아래에 팀원을 둡니다 | 추가 | [agent-groups](../docs/mods/agent-groups.md) |
| 리더 탭 (`leader-tabs`) | 리더 세션이 둘 이상이면 칸 머리줄에 리더 탭을 띄웁니다 | 추가 | [leader-tabs](../docs/mods/leader-tabs.md) |
| 경로 메뉴 (`path-menu`) | 터미널의 파일 경로를 Cmd·Ctrl+클릭하면 폴더 열기·파일 열기·경로 복사 메뉴를 띄웁니다 | 추가 | [path-menu](../docs/mods/path-menu.md) |
| PO 데스크 (`inbox`) | 리더 결과 보고를 채팅처럼 보여 주고, 결정이 필요한 보고에 답하거나 채팅칸에서 `@리더`로 말하면 PO 터미널에 입력으로 전해 줍니다 | 추가 | [inbox](../docs/mods/inbox.md) |

<!-- 새 모드: docs/mods/<모드>.md를 같은 틀(제목, 한 줄 소개, 스크린샷, 사용법, 필요한 것, 설치, 돌아가기 링크)로 만들고 위 표와 ../README.md 모드 표에 한 줄씩 더합니다. -->

- **기본**: 옵션 없이 설치하면 들어갑니다.
- **추가**: `--extras`(Windows는 `-Extras`)로 모두 넣거나, `--add <모드>`로 하나씩 넣습니다.
  - `usage-status`·`agent-groups`·`leader-tabs`는 Herdr 기본 모드를 복제해 기능을 더한 것입니다.
  - 해당 정보가 없으면 기본 모드와 거의 같게 보입니다.
- 스크린샷은 설명용 데모 저장소(`demo-app`)를 열어 실제로 찍은 화면입니다.
  - 저장소 이름, 이슈, 브랜치는 모두 설명용으로 지어낸 것입니다.

---

## 설치

### 필요한 것

| 항목 | 용도 |
| --- | --- |
| Herdr 앱 | 한 번 실행해 설정 폴더가 있어야 합니다.<br>처음 설치할 때는 앱이 켜져 있어야 레이아웃을 만듭니다.<br>`hc` 명령은 Herdr에 들어 있습니다. |
| Node.js | 설치기와 Work·PRs·예약 패널이 씁니다. 꼭 있어야 합니다. |
| GitHub CLI(`gh`) | Work·PRs 패널이 GitHub 데이터를 읽습니다. `gh auth login`으로 로그인해 두세요. |

- macOS에서 확인했습니다.
- Windows 설치기와 Windows 경로 처리는 작성돼 있지만, 실제 Windows PC에서는 아직 확인하지 않았습니다.
- Windows에서 Herdr 설정 폴더가 다르면 `HERDR_APP_HOME`을 지정하세요.

### 설치 명령

Herdr 앱을 켠 상태에서 한 줄로 설치합니다.

macOS·Linux:

```sh
# 기본 모드
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh
# 추가 모드까지
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --extras
```

Windows(PowerShell):

```powershell
# 기본 모드
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1)))
# 추가 모드까지
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -Extras
```

저장소를 받아서 실행해도 됩니다.

```sh
git clone https://github.com/xowjd913/agent-mods
sh agent-mods/herdr/install.sh            # Windows: .\agent-mods\herdr\install.ps1
sh agent-mods/herdr/install.sh --extras   # Windows: .\agent-mods\herdr\install.ps1 -Extras
```

설치가 끝나면:

- Herdr가 `dashboard` 레이아웃으로 바뀌고, 탭 줄에 `Work`·`PRs`·`예약` 버튼이 보입니다.
- 원래 쓰던 `main` 레이아웃은 그대로이며, `ctrl-shift-l`로 언제든 오갈 수 있습니다.

잘 안 될 때:

- 앱이 꺼져 있었다면 모드만 복사됩니다. 앱을 켜고 같은 명령을 한 번 더 실행하세요.
- 문제가 생겨도 설치기는 안내만 출력하고 끝나며, Herdr 설정을 망가뜨리지 않습니다.

### 모드 골라 설치

기본 모드나 추가 모드를 통째로 넣지 않고, 필요한 모드만 골라 넣거나 뺄 수 있습니다.

| macOS·Linux | Windows | 하는 일 |
| --- | --- | --- |
| (옵션 없음) | (옵션 없음) | 설치된 모드만 갱신합니다. 처음이면 기본 모드 5개를 설치합니다. |
| `--extras` | `-Extras` | 모드 9개를 모두 설치합니다. |
| `--only <모드>` | `-Only <모드>` | 고른 모드만 설치·갱신합니다. 이미 설치된 다른 모드는 그대로 둡니다. |
| `--add <모드>` | `-Add <모드>` | 설치된 모드에 고른 모드를 더합니다. |
| `--remove <모드>` | `-Remove <모드>` | 고른 모드를 지우고, 그 모드가 바꾼 레이아웃 블록을 되돌립니다. |
| `--list` | `-List` | 모드마다 설명과 설치 상태를 보여 줍니다. |

- `<모드>`는 [모드 표](#모드)의 괄호 안 이름입니다(`work`, `usage-status` 등).
- 여러 개는 쉼표로 잇습니다(`--only work,prs`).

macOS·Linux 예:

```sh
# Claude 사용률(usage-status)만 설치
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --only usage-status

# PRs 패널 더하기 (work, tabs-mine, wt-menu도 함께 들어감)
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --add prs

# 리더 탭 빼기
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --remove leader-tabs

# 설치 상태 보기
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --list
```

Windows(PowerShell) 예:

```powershell
# Claude 사용률(usage-status)만 설치
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -Only usage-status

# 설치 상태 보기
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -List
```

저장소를 받았다면 `sh agent-mods/herdr/install.sh --only usage-status`처럼 씁니다.
Windows는 `.\agent-mods\herdr\install.ps1 -Only usage-status`입니다.

알아 둘 점:

- 옵션은 한 번에 하나만 씁니다. 둘을 함께 주면 아무것도 하지 않고 안내만 출력합니다.
- 모르는 모드 이름을 주면 쓸 수 있는 이름을 보여 주고 끝납니다.
- 필요한 모드는 자동으로 함께 설치합니다.
  - `work`: `tabs-mine`, `wt-menu`
  - `prs`: `work`, `tabs-mine`, `wt-menu`
  - `schedules`: `tabs-mine`
  - `inbox`: `tabs-mine`
- 남은 모드가 쓰는 모드는 지우지 않습니다.
  - 예: `work`가 설치돼 있으면 `--remove wt-menu`는 아무것도 지우지 않고, 함께 지울 이름을 알려 줍니다.
- `--remove`(Windows는 `-Remove`)는 고른 모드 폴더를 지우고, 그 모드가 바꾼 레이아웃 블록을 되돌립니다.
  - 모드 폴더 밖의 예약 기록, PRs `옆에 열기` 기록, 캐시는 남습니다([데이터가 저장되는 곳](#데이터가-저장되는-곳)).

---

## 업데이트와 제거

### 업데이트

설치 명령을 옵션 없이 다시 실행합니다. 몇 번을 실행해도 결과가 같습니다.

- 설치돼 있는 모드만 갱신합니다.
  - 추가 모드를 한 번 설치했다면 `--extras` 없이 실행해도 추가 모드가 함께 갱신됩니다.
- 화면이 바로 바뀌지 않으면 `ctrl-shift-l`로 다른 레이아웃에 갔다가 돌아오세요.
- 레이아웃에서 직접 되돌린 블록은 다시 바꾸지 않습니다.
  - 원하는 대로 고쳐 쓴 화면이 업데이트로 덮이지 않습니다.

### 제거

모드 하나만 빼려면 [모드 골라 설치](#모드-골라-설치)의 `--remove`를 씁니다.
모두 지울 때는 다음 순서를 따릅니다.

1. `ctrl-shift-l`로 `main` 등 다른 레이아웃으로 바꿉니다.
2. `<설정 폴더>/layouts/dashboard.json`을 지웁니다.
3. `<설정 폴더>/mods/` 아래에서 `.installed-by-herdr-installer` 표시 파일이 있는 폴더를 지웁니다.
   - 각 단계의 기록 파일(`.tabs-swapped` 등)도 이 폴더 안에 있어 함께 지워집니다.
4. 필요하면 남은 기록도 지웁니다.
   - 예약과 실행 기록: `<설정 폴더>/schedules/`
   - 캐시: `<설정 폴더>/cache/collect.json`
   - PRs의 `옆에 열기` 기록: `<설정 폴더>/data/prs/`
   - inbox를 `--remove`가 아니라 폴더로 지웠다면, Claude 설정(`~/.claude/settings.json`)의 `Stop`·`UserPromptSubmit`에서 `po-hook.cjs` 줄도 직접 지웁니다(없는 파일을 부르는 줄이 남으면 훅 오류 표시가 날 수 있습니다).

`<설정 폴더>`는 `HERDR_APP_HOME`이고, 지정하지 않았다면 `~/.config/herdr-app`입니다.

macOS·Linux:

```sh
H="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
rm -f "$H/layouts/dashboard.json"
for d in "$H"/mods/*/; do [ -f "$d.installed-by-herdr-installer" ] && rm -rf "$d"; done
```

Windows(PowerShell):

```powershell
$H = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $H 'layouts\dashboard.json')
Get-ChildItem (Join-Path $H 'mods') -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName '.installed-by-herdr-installer') } |
  Remove-Item -Recurse -Force
```

**예전 설치 스크립트로 설치했던 경우**에는 다음도 남아 있을 수 있습니다. 위 명령은 이것들을 지우지 않습니다.

- `<설정 폴더>/layouts/agent-groups.json`: 예전 설치가 만든 레이아웃입니다.
  - 새 설치기는 이 레이아웃이 있으면 `dashboard`를 새로 만들지 않고 이것을 계속 씁니다.
- `.installed-by-agent-playbook` 표시 파일만 있는 모드 폴더.
  - 새 설치기로 한 번 다시 설치하면 새 표시 파일도 생깁니다.

---

## 동작 방식

### 설치기가 하는 일

설치 스크립트(`install.sh`, `install.ps1`)는 환경을 확인한 뒤 공통 도우미 `install.cjs`를 부릅니다.

1. **모드 복사**: `herdr/mods/<모드>/`를 `<설정 폴더>/mods/<모드>/`에 복사합니다.
   - `.installed-by-herdr-installer` 표시 파일을 남깁니다.
   - 표시가 없는 같은 이름 폴더는 직접 만든 모드로 보고 덮어쓰지 않습니다.
   - `inbox`는 PO 답 훅도 더합니다: `mods/inbox/po-hook.cjs`가 복사된 뒤 `install.cjs hook`이 Claude Code 설정(`~/.claude/settings.json`, 또는 `$CLAUDE_CONFIG_DIR`)에 **훅 명령 하나**를 두 이벤트(`Stop`, `UserPromptSubmit`)에 넣습니다. 명령이 정확히 `node "<경로>/mods/inbox/po-hook.cjs"`인 줄만 우리 것으로 알아봅니다. 다른 훅은 그대로 두고 여러 번 실행해도 한 번만 들어가며, 쓰기 전에 백업합니다. 설정 파일이 올바른 JSON이 아니면 아무것도 쓰지 않고 안내만 합니다(설치 자체는 계속됩니다). `--remove inbox`는 우리 줄만 뺍니다. 이미 켜진 PO 세션은 다시 시작해야 합니다. 자세한 규칙은 [inbox](../docs/mods/inbox.md#po-답-훅-터미널을-안-보고-답-받기)에 있습니다.
2. **레이아웃 만들기**: `dashboard` 레이아웃이 없으면 실행 중인 앱에 `herdr-app do layout.clone`을 보냅니다.
   - `main`을 복제하고, 그 레이아웃으로 바꿉니다.
3. **블록 넣기**: `dashboard`에 설치된 모드의 블록을 넣습니다.
   - `tabs-mine`: 탭 줄 `tabs`를 `tabs-mine`으로 바꿉니다.
   - `work`·`prs`·`schedules`·`inbox`: 오른쪽 패널에 `work-board`, `pr-board`, `schedules-board`, `inbox-board`를 더합니다.
   - `agent-groups`: `agents`를 `agent-groups`로 바꿉니다.
   - `usage-status`: `workspace-status`를 `usage-status`로 바꿉니다.
   - `leader-tabs`: 칸 머리줄 `pane`을 `leader-tabs`로 바꿉니다.
   - `path-menu`: 레이아웃 맨 위 `link_handlers`에 `path-menu`를 더합니다.
4. **기록 남기기**: 단계마다 모드 폴더 안에 기록 파일을 남깁니다.
   - 예: `.tabs-swapped`, `.work-board-added`, `.pr-board-added`, `.board-added`, `.agents-swapped`, `.status-swapped`, `.header-swapped`, `.link-handler-added`
   - 다음 설치는 기록이 있는 단계를 건너뛰므로, 사용자가 되돌린 블록은 그대로 둡니다.

같은 이름이지만 이 설치기의 모드를 쓰지 않는 `dashboard` 레이아웃이 이미 있으면, 그 레이아웃은 건드리지 않습니다.

### 패널이 데이터를 얻는 방법

- Work·PRs·`PRs` 버튼 숫자는 모두 `mods/work/collect.cjs` 하나가 모은 JSON을 씁니다.
  - collect.cjs는 Herdr 터미널 목록, 각 저장소의 git 워크트리, Claude Code 세션 기록(`~/.claude`)을 로컬에서 읽습니다.
  - GitHub 이슈·PR·리뷰·CI는 `gh`로 GraphQL 한 번에 읽습니다. 쓰기는 하지 않습니다.
  - 캐시는 로컬 30초, GitHub 3분입니다. 처음 읽을 때는 5~15초쯤 걸립니다.
- PO 데스크는 오른쪽 패널(Dock)과 떠 있는 창(키 `inbox`, 위치 기억), 터미널 옆 페인(`옆에 열기`: 리더 옆에 `pane.split {mod: "inbox", props: {mode: "pane"}}`, 탭에 이미 있으면 그쪽으로 포커스)이 **같은 메신저 화면**(PO별 방 + 타임라인 + 채팅 상자)입니다. Dock은 좁아서 방 목록이 58px 좁은 칸(동그라미·숫자, 이름은 툴팁)이고 머리줄에 `대기 n`과 `창 열기`가 있으며, 방 목록은 모드가 아니라 자기 폭으로 고릅니다(520px 이상이면 168px 목록, 좁으면 58px 칸, 좁은 창만 위쪽 띠). Dock은 30초(앱 아이콘 숫자도 맡음), 창은 열려 있는 동안·페인은 그려지는 동안 5초마다 `mods/inbox/inbox.cjs`를 불러 `~/.herdr-inbox/<리더>.jsonl`(리더 보고 기록)을 읽습니다. 읽기만 하고 쓰지 않습니다.
  - 탭 줄 `PO 데스크` 숫자는 `tabs-mine`이 `wait` 라벨이 `decision`·`verify`인 `lead-*` 터미널을 직접 셉니다. Dock 머리줄의 `대기 n`과 앱 아이콘 숫자도 같은 규칙이라 서로 같고, 패널이 닫혀 있어도 맞습니다.
  - 카드는 접힌 채 시작하고(`자세히`/`접기` 버튼으로 펼침, 상태 저장), 펼친 본문은 목록·소제목으로 풀어 보여 줍니다. 백틱 코드·`$ ` 줄·줄 전체가 명령인 이름표 줄만 `복사` 버튼이 있는 고정폭 상자에 담고, 링크는 `PR #26`처럼 짧은 이름으로 앱 안 `open_url`로 엽니다. 카드 글자는 모두 드래그로 골라 `Cmd+C`로 복사할 수 있고, 타임라인 말풍선과 질문 패널의 PO 화면 줄도 같습니다(질문 패널 줄은 이전에 선택이 안 되던 것을 고쳤고, 실제 화면에서는 직접 확인해야 합니다).
  - 타임라인 위 칩 줄(`전체`·`안 읽은 것`·`결정 필요`·`최종 확인 요청`·`결과`·`멈춤`, 칩마다 개수)로 그 방의 말풍선을 골라 봅니다. 종류 칩에서는 내가 보낸 글이 숨겨지고, `안 읽은 것`은 방을 열 때의 읽음 기준으로 거릅니다. 필터는 방마다 따로 기억하지만 저장하지 않아서 다시 열면 `전체`입니다. 자세한 규칙은 [inbox](../docs/mods/inbox.md#채팅-필터)에 있습니다.
  - 창의 `결정 필요`·`결과 보고` 칸은 머리줄(`▾`/`▸`)을 눌러 접고 펼 수 있고 상태가 저장됩니다. 답을 이미 보낸 결정·확인은 `결과 보고`에 중립색 `결정 · 답함` 표시로 남고, 붉은 표시는 기다리는 건에만 붙습니다. 제목·소제목은 본문보다 큰 글자로 보입니다.
  - 답(`확인 완료`·`답 쓰기`·`N안 선택` 칩)과 채팅은 한 길로 클립보드에 담아 PO 칸(리더 터미널의 부모, `role=po` 라벨 필수)에 붙여 넣고 `hc keys <PO> enter`까지 눌러 보냅니다. PO가 질문 중(`blocked`)이면 붙여 넣기만 하고, 보내도 PO 데스크는 닫히지 않습니다. `Enter 누르기` 버튼은 누르기 전에 입력창에 글이 있는지 `hc read`로 확인하고(없으면 누르지 않음), 10분이 지난 기록은 `다시 보내기`만 남깁니다.
    - 보낸 글은 `deliver` 한 곳에서 한 번만 기록되어 내 말풍선(오른쪽, 리더·PO는 왼쪽)으로 나오고, 상태(`보내는 중`·`Enter 안 눌림`·`보내지 못함`·`질문 중이라 붙여 넣기만`)는 Enter 결과가 나온 뒤에 바뀝니다. `다시 보내기`·`Enter 누르기` 버튼이 붙습니다.
    - PO 칸이 없으면 열고 칸이 생기면 한 번만 자동으로 보냅니다(6초 안에 안 열리면 `다시 보내기`). 보내기 전에 키보드가 있던 칸은 Dock·창·페인 모두 Enter 뒤에 돌려줍니다.
    - PO·리더가 일하는 중이면 `전체` 타임라인 아래에 `···` 말풍선이 뜨고, 인박스 폴더를 지켜봐 새 글이 바로 올라옵니다. 입력칸은 Enter로 보내고 Shift+Enter로 줄을 바꿉니다. 자세한 내용과 확인하지 못한 것은 [inbox](../docs/mods/inbox.md#방의-타임라인)에 있습니다.
    - PO가 질문 중이면 방에 질문 패널(`hc read` 화면 끝 + 번호·Enter·Esc 버튼)이 떠서 터미널 없이 답할 수 있습니다. 키는 누를 때마다 PO가 아직 질문 중일 때만 눌리고, 스스로 승인하지 않습니다. 자세한 내용과 확인하지 못한 것은 [inbox](../docs/mods/inbox.md#막힌-po의-질문에-답하기)에 있습니다.
  - 결정 보고 본문에 `1안: …` 줄이 서로 다른 번호로 둘 이상이면 `N안 선택` 칩이 나오고, `추천: N안` 줄이 가리키는 칩만 강조됩니다(형식은 리더 보고 규칙, agent-playbook #380).
- 예약 패널은 `mods/schedules/schedules.cjs`를 30초마다 불러 때가 된 예약을 실행합니다.
  - 실행은 `hc run --bg`로 세션을 띄운 뒤 `hc send`로 프롬프트를 보내는 방식입니다.

---

## 데이터가 저장되는 곳

| 위치 | 내용 | 지워도 되나 |
| --- | --- | --- |
| `<설정 폴더>/mods/<모드>/` | 설치된 모드와 단계 기록 파일 | 제거할 때 지웁니다 |
| `<설정 폴더>/layouts/dashboard.json` | 설치기가 만든 레이아웃 | 제거할 때 지웁니다 |
| `<설정 폴더>/cache/collect.json` | Work·PRs 캐시 | 언제든. 다시 만들어집니다 |
| `<설정 폴더>/schedules/` | 예약(`automations.json`)과 실행 기록(`runs.json`) | 지우면 예약이 사라집니다 |
| `<설정 폴더>/data/prs/` | PRs `옆에 열기` 상태 | 언제든 |
| `~/.claude/settings.json` (또는 `$CLAUDE_CONFIG_DIR/settings.json`) | `inbox` 설치 때 `hook` 명령이 `Stop`·`UserPromptSubmit` 두 이벤트에 더하는 PO 답 훅 명령 하나(`po-hook.cjs`) | 설치기가 쓰기 전에 `settings.json.bak-herdr-<시각>`으로 백업합니다. `--remove inbox`나 `node install.cjs hook --remove`가 우리 줄만 뺍니다 |
| `~/.claude/usage-limits.json` | usage-status가 읽는 파일(다른 도구가 씀) | 이 저장소가 만들지 않습니다 |
| `~/.herdr-inbox/<리더>.jsonl` | inbox가 읽는 리더 보고 기록(`report`가 씀) | 이 저장소가 만들지 않습니다. 지우면 그 리더의 보고가 사라집니다 |
| `~/.herdr-inbox/po/<po id>.jsonl` | PO 데스크 채팅이 읽는 그 PO의 답(`{ts, kind:"say" 또는 "me", text, to?}` 한 줄씩. `me`는 터미널에 직접 친 글). PO 답 훅(`po-hook.cjs`)도 여기에 씁니다(프롬프트 글이 들어가므로 `0600`, 1 MiB를 넘으면 가장 새 256 KiB만 남깁니다). id는 PO 터미널의 `po` 라벨(소문자·숫자·`-`, 1~40자) | 이 저장소가 만들지 않습니다. 없으면 답이 없는 것으로 봅니다. 옛 `po.jsonl`은 읽지 않습니다 |

패널 선택이나 토글 같은 화면 설정은 Herdr가 모드마다 따로 보관합니다.
