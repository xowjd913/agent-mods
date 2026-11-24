# agent-mods

AI 에이전트(Claude Code, Codex 등) 여러 개를 동시에 돌릴 때 누가 무엇을 하는지와 손봐야 할 PR을 터미널 작업 공간 앱 [Herdr](https://github.com/herdrdev/herdr) 화면 안에서 바로 보여 주고, 정해진 시각에 에이전트를 띄워 실행해 주는 모드(mod) 모음입니다.

![탭 줄 오른쪽의 Files·Changes·Work·PRs·예약 버튼과, 예약 패널을 연 화면](docs/images/herdr-overview.png)

> 📸 **TODO(스크린샷)**: 대표 화면으로 교체. 사이드바 세션 목록과 오른쪽 Work 패널이 함께 찬 화면. 예정 파일 `docs/images/herdr-main.png`

## 모드

| 모드 | 하는 일 | 설치 | 자세히 |
| --- | --- | --- | --- |
| Work (`work`) | 세션마다 맡은 이슈, 워크트리, PR, CI를 한 트리로 봅니다 | 기본 | [보기](herdr/README.md#work-누가-무엇을-하고-있나) |
| PRs (`prs`) | 저장소별 열린 PR과 리뷰 상태, 정리할 워크트리를 봅니다 | 기본 | [보기](herdr/README.md#prs-무엇을-손봐야-하나) |
| 예약 (`schedules`) | 정해진 시각에 Claude나 Codex 세션을 띄워 프롬프트를 보냅니다 | 기본 | [보기](herdr/README.md#예약-정해진-시각에-에이전트-돌리기) |
| 워크트리 메뉴 (`wt-menu`) | 워크트리를 IDE, Herdr 공간, Finder·탐색기, GitHub로 바로 엽니다 | 기본 | [보기](herdr/README.md#워크트리-메뉴-wt-menu) |
| 패널 버튼 (`tabs-mine`) | 탭 줄에 Work·PRs·예약 버튼을 붙이고, 손봐야 할 PR 수를 띄웁니다 | 기본 | [보기](herdr/README.md#오른쪽-패널-버튼-tabs-mine) |
| Claude 사용률 (`usage-status`) | 아래 상태 줄에 Claude 5시간·7일 사용률을 막대로 보여 줍니다 | 추가 | [보기](herdr/README.md#usage-status-claude-사용률) |
| 작업별 묶음 (`agent-groups`) | 사이드바에서 터미널을 이슈 번호별로 묶고 리더를 맨 위에 둡니다 | 추가 | [보기](herdr/README.md#agent-groups-작업별-묶음) |
| 리더 탭 (`leader-tabs`) | 리더 세션이 둘 이상이면 칸 머리줄에 리더 탭을 띄웁니다 | 추가 | [보기](herdr/README.md#leader-tabs-리더-탭) |

지금은 Herdr용 모드만 있습니다([`herdr/`](herdr/)). Claude Code(`claude/`)와 Orca(`orca/`)용은 계획 중입니다.

## 빠른 설치

1. **준비**: [Herdr](https://github.com/herdrdev/herdr) 앱을 한 번 실행해 두고 켜 둡니다. [Node.js](https://nodejs.org/)와 [GitHub CLI](https://cli.github.com/)(`gh auth login`으로 로그인)가 필요합니다.
2. **설치 명령 한 줄** (추가 모드까지 넣으려면 [설치 안내](herdr/README.md#설치-명령)의 `--extras` 명령을 씁니다)

   macOS·Linux:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh
   ```

   Windows(PowerShell):

   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1)))
   ```

3. **Herdr 확인**: 탭 줄에 `Work`·`PRs`·`예약` 버튼이 보이면 끝입니다. 안 보이면 `ctrl-shift-l`로 레이아웃을 바꿨다 돌아오고, 앱이 꺼져 있었다면 앱을 켜고 같은 명령을 한 번 더 실행합니다.

macOS에서 확인했습니다. Windows는 설치기가 있지만 실제 PC에서는 아직 확인하지 않았습니다.

- **업데이트**: 설치 명령을 다시 실행합니다. 직접 고친 레이아웃은 덮어쓰지 않습니다.
- **제거**: [제거 안내](herdr/README.md#제거)대로 `dashboard` 레이아웃과 설치기가 표시한 모드 폴더를 지웁니다.

자세한 요구 사항, 동작 방식, 데이터 저장 위치는 [herdr/README.md](herdr/README.md)에 있습니다.

## 기여

버그 제보, 개선 제안, PR 모두 환영합니다.

1. 이 저장소를 fork하고 브랜치를 만들어 고칩니다.
2. 저장소 최상위에서 `node --test`를 돌립니다. 모드를 고쳤다면 설치한 뒤 `herdr-app check <설정 폴더>/mods/<모드>`로 앱에서 확인해 주세요.
3. `main`으로 PR을 엽니다. 무엇을 왜 바꿨는지, 어떻게 확인했는지 적어 주세요.

`main`에는 PR로만 들어가고 코드 소유자(CODEOWNERS)가 리뷰·승인합니다. 처음 기여하는 분의 PR은 GitHub Actions가 돌기 전에 관리자 승인을 한 번 거칩니다. CI는 macOS·Linux·Windows에서 `node --test`와 설치 스크립트 문법 검사를 돌립니다.

## 라이선스

[Apache License 2.0](LICENSE). 일부 모드는 Herdr 기본 모드를 복제해 고친 것입니다. 자세한 내용은 [NOTICE](NOTICE)를 보세요.
