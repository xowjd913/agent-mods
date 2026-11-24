# agent-mods

AI 에이전트 작업 도구에 붙여 쓰는 모드(mod) 모음입니다. 도구마다 최상위 폴더 하나를 씁니다.

| 폴더 | 도구 | 상태 |
| --- | --- | --- |
| [`herdr/`](herdr/) | [Herdr](https://github.com/herdrdev/herdr) | 사용 가능 |
| `claude/` | Claude Code | 계획 |
| `orca/` | Orca | 계획 |

---

## Herdr

Herdr 앱의 탭 줄·오른쪽 패널·사이드바에 작업 현황 화면을 더합니다. 모드는 Herdr 설정 폴더(`~/.config/herdr-app`, 또는 `HERDR_APP_HOME`)의 `mods/` 아래에 설치되고, 설치기가 만든 `dashboard` 레이아웃에 배치됩니다. 기본 레이아웃(`main`)은 바꾸지 않습니다.

### 필요한 것

| 항목 | 용도 |
| --- | --- |
| Herdr 앱 | 한 번 실행해 설정 폴더가 있어야 하고, 처음 설치할 때 앱이 켜져 있어야 레이아웃을 만듭니다. `hc`는 Herdr에 들어 있습니다. |
| Node.js | 설치기와 Work·PRs·예약 패널이 씁니다. 필수입니다. |
| GitHub CLI(`gh`) | Work·PRs 패널이 GitHub 데이터를 읽습니다. `gh auth login`으로 로그인해 두세요. 없으면 그 부분만 비어 있습니다. |

macOS에서 확인했습니다. Windows용 설치기와 Windows 경로 처리는 작성돼 있지만 실제 Windows PC에서는 아직 확인하지 않았습니다. Windows에서 설정 폴더가 다르면 `HERDR_APP_HOME`을 지정하세요.

### 설치

Herdr 앱을 켠 상태에서 실행합니다.

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

설치기가 하는 일:

1. 모드 폴더를 `<설정 폴더>/mods/<모드>/`에 복사하고 `.installed-by-herdr-installer` 표시 파일을 남깁니다. 이 표시가 없는 같은 이름 폴더는 덮어쓰지 않고 건너뜁니다.
2. `dashboard` 레이아웃이 없으면 실행 중인 앱에서 `main`을 복제해 만들고, 그 레이아웃으로 바꿉니다. 다른 레이아웃으로 가려면 `ctrl-shift-l`을 누릅니다.
3. `dashboard` 레이아웃에 모드 블록을 넣습니다. 각 단계는 처음 한 번만 하고 기록을 남기므로, 직접 되돌린 블록은 다시 바꾸지 않습니다.

앱이 꺼져 있으면 모드만 복사하고 레이아웃은 다음 실행 때 만듭니다. 문제가 있어도 안내만 출력하고 끝납니다.

### 업데이트

설치 명령을 다시 실행합니다. 몇 번 실행해도 결과가 같습니다. 추가 모드를 한 번 설치했다면 `--extras` 없이 실행해도 추가 모드가 함께 갱신됩니다. 레이아웃이 바로 바뀌지 않으면 `ctrl-shift-l`로 다른 레이아웃에 갔다가 돌아오세요.

### 제거

1. `ctrl-shift-l`로 `main` 등 다른 레이아웃으로 바꿉니다.
2. `<설정 폴더>/layouts/dashboard.json`을 지웁니다.
3. `<설정 폴더>/mods/` 아래에서 `.installed-by-herdr-installer` 표시가 있는 폴더를 지웁니다.
4. 예약 데이터까지 지우려면 `<설정 폴더>/schedules/`를, 캐시까지 지우려면 `<설정 폴더>/cache/collect.json`을 지웁니다.

macOS·Linux 예시:

```sh
H="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
rm -f "$H/layouts/dashboard.json"
for d in "$H"/mods/*/; do [ -f "$d.installed-by-herdr-installer" ] && rm -rf "$d"; done
```

### 모드

기본 모드는 늘 설치되고, 추가 모드는 `--extras`(`-Extras`)를 줄 때만 설치됩니다.

| 모드 | 구분 | 위치 | 하는 일 |
| --- | --- | --- | --- |
| `tabs-mine` | 기본 | 탭 줄 | Herdr 기본 `tabs` 모드를 복제하고 `Work`·`PRs`·`예약` 버튼을 더했습니다. `PRs` 버튼에는 내가 손봐야 할 PR 수가 뜹니다. |
| `work` | 기본 | 오른쪽 패널 | 세션 트리입니다. 세션마다 작업 중인 이슈(제목, Status, 에픽 진행률), 워크트리(브랜치, PR, CI), 마지막 작업 줄을 보여 줍니다. |
| `prs` | 기본 | 오른쪽 패널 | 저장소별 열린 PR 목록입니다. CI 점과 리뷰 상태(`승인`, `수정 요청`, `리뷰 대기`, `리뷰 요청`)를 보여 줍니다. `옆에 열기`로 터미널 옆 칸에 띄울 수도 있습니다. |
| `wt-menu` | 기본 | 팝업 | Work 패널의 워크트리 줄을 누르면 열립니다. 이 PC에 있는 IDE로 열기, Herdr 공간으로 가기, Finder·탐색기에서 보기, 경로 복사, PR 열기를 할 수 있습니다. |
| `schedules` | 기본 | 오른쪽 패널 | 정해진 시각에 Claude나 Codex 세션을 띄워 프롬프트를 보내는 예약입니다. 아래에 따로 설명합니다. |
| `usage-status` | 추가 | 아래 상태 줄 | Herdr 기본 `workspace-status`를 복제하고 오른쪽에 Claude 사용률(5시간·7일)을 붙였습니다. |
| `agent-groups` | 추가 | 사이드바 | Herdr 기본 `agents`를 복제하고 `작업별 묶음` 보기를 더했습니다. 터미널을 이슈 번호별로 묶고 리더를 맨 위에 둡니다. |
| `leader-tabs` | 추가 | 칸 머리줄 | Herdr 기본 `pane` 머리줄을 복제했습니다. 한 PO 아래 리더가 둘 이상이면 머리줄에 리더 탭을 보여 줍니다. |

#### Work · PRs

- 둘 다 `mods/work/collect.cjs`가 모은 데이터를 보여 줍니다. Herdr 터미널, 각 저장소의 git 워크트리, `gh`로 읽은 GitHub 이슈·PR·리뷰·CI를 읽기만 하고, GitHub에는 아무것도 쓰지 않습니다.
- 자동 새로고침은 캐시(로컬 30초, GitHub 3분)를 쓰고, `↻` 버튼은 캐시 없이 바로 다시 읽습니다. 처음 읽을 때는 5~15초쯤 걸립니다.
- `PRs` 버튼 숫자는 CI가 실패했거나 수정 요청을 받은 내 PR과, 내 리뷰를 기다리는 PR의 수입니다.

#### 예약(schedules)

- **Herdr 앱이 켜져 있을 때만** 돌아갑니다. 앱이 꺼져 있거나 PC가 잠든 동안 놓친 실행은, 앱이 다시 켜졌을 때 가장 최근 한 번만 허용 시간 안이면 실행하고 아니면 `놓침`으로 기록합니다.
- 주기: `매시간`, `매일`, `평일`, `매주`, 5칸 cron, RRULE. 시간대와 서머타임을 처리합니다.
- 실행 폴더: 기존 폴더, 또는 실행마다 새 워크트리(`auto/<이름>-<시각>` 브랜치).
- 실행은 `hc run --bg`로 세션을 띄운 뒤 `hc send`로 프롬프트를 보냅니다. Claude는 `--permission-mode auto`, Codex는 `--approve-for-me`로 띄우며 `--dangerously-*` 옵션은 쓰지 않습니다. 권한·질문 화면에서 멈추면 `입력 대기`로 기록하고 키를 대신 누르지 않습니다.
- 알림: 예약마다 `끄기`, `문제만`(기본), `모두`를 고릅니다. Herdr 안의 알림과 OS 알림(macOS 알림 센터, Windows 토스트, Linux `notify-send`)을 함께 보냅니다.
- 예약과 실행 기록은 `<설정 폴더>/schedules/`에 저장돼 다시 설치해도 남습니다.

#### usage-status

- `~/.claude/usage-limits.json`을 1분마다 읽기만 합니다. 네트워크 호출은 없습니다.
- 이 파일은 Claude Code 상태 줄(statusline) 스크립트 등이 따로 써 줘야 합니다. 형식은 다음과 같습니다.

  ```json
  { "updatedAt": "2026-01-01T09:00:00Z", "limits": [ { "kind": "five_hour", "percentUsed": 42 }, { "kind": "seven_day", "percentUsed": 16 } ] }
  ```

- 파일이 없거나 10분 넘게 갱신되지 않으면 `Claude Unknown`을 보여 줍니다.

#### agent-groups · leader-tabs

- 터미널 라벨 `role=po`, `role=leader`, `group-issue`, `session`과 `hc` 이름(`dev-<이슈>`, `review-<이슈>` 등)으로 묶음을 정합니다. 라벨이 없으면 기본 `agents`·`pane`과 거의 같게 보입니다.
- `leader-tabs`는 `~/.claude/skills/leader/herdr-team.sh`가 있으면 리더 칸 정리에 그것을 부르고, 없으면 그 동작만 하지 않습니다.

### 테스트

저장소 최상위에서 실행합니다.

```sh
node --test
```

모드 하나를 앱에서 확인하려면 설치 뒤 `herdr-app check <설정 폴더>/mods/<모드>`를 실행합니다.

---

## 기여

1. 이 저장소를 fork합니다.
2. fork에서 브랜치를 만들어 고치고 `node --test`를 통과시킵니다.
3. `main`으로 PR을 엽니다. 무엇을 왜 바꿨는지, 어떻게 확인했는지 적어 주세요.

`main`에는 PR로만 들어가며, 코드 소유자(CODEOWNERS)의 승인이 필요합니다. 처음 기여하는 분의 PR은 Actions 실행 전에 승인을 거칩니다.

## 라이선스

[Apache License 2.0](LICENSE). 일부 모드는 Herdr 기본 모드를 복제해 고친 것입니다. 자세한 내용은 [NOTICE](NOTICE)를 보세요.
