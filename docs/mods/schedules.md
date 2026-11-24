# 예약 (schedules)

정해진 시각에 Herdr가 Claude나 Codex 세션을 띄우고 프롬프트를 보냅니다.

![꺼 둔 예약 세 개(평일 09:00, 매주 월 17:00, cron)가 있는 예약 패널](../images/herdr-schedules.png)

## 사용법

### 예약 예

- "평일 아침 9시에 열린 이슈 정리"
- "금요일 17시에 주간 보고 초안"

### 예약마다 정하는 것

| 항목 | 고를 수 있는 값 |
| --- | --- |
| 일정 | `매시간`, `매일`, `평일`, `매주`, 사용자 지정 cron(5칸), 사용자 지정 RRULE |
| 프로그램 | Claude 또는 Codex. 모델과 에포트도 고릅니다. |
| 폴더 | 기존 폴더, 또는 실행마다 새 워크트리(`auto/<이름>-<시각>` 브랜치) |
| 세션 | 매번 새로 시작하거나, 지난 실행 세션이 살아 있으면 거기에 다시 보냅니다. |
| 사전 확인 | 실행 전에 돌릴 명령. 종료 코드가 0이 아니면 `검사로 건너뜀`으로 기록합니다. |
| 유예 시간 | 놓친 실행을 얼마나 늦게까지 따라잡을지 |
| 알림 | `끄기`, `문제만`(기본: 실패·입력 대기·놓침), `모두`(완료 포함) |

일정은 시간대와 서머타임을 처리합니다.

### 실행과 기록

- **Herdr 앱이 켜져 있을 때만 돌아갑니다.**
- 앱이 꺼져 있었거나 PC가 잠들어 놓친 실행은, 앱이 다시 켜졌을 때 가장 최근 한 번만 봅니다.
  - 유예 시간 안이면 `놓친 실행`으로 돌립니다.
  - 아니면 `놓침`으로 기록합니다.
- 실행 기록 상태: `실행 중`, `완료`, `입력 대기`, `실패`, `검사로 건너뜀`, `놓침`
- `지금 실행`으로 바로 돌려 볼 수 있습니다.

### 알림

- Herdr 안의 알림과 OS 알림으로 함께 갑니다.
- OS 알림: macOS 알림 센터, Windows 토스트, Linux `notify-send`

### 권한

- Claude는 `--permission-mode auto`, Codex는 `--approve-for-me`로 띄웁니다.
- `--dangerously-*` 옵션은 쓰지 않습니다.
- 에이전트가 권한·질문 화면에서 멈추면 키를 대신 누르지 않습니다.
  - 그 실행은 `입력 대기`로 기록합니다.

### 실행 방식

- [패널 버튼](tabs-mine.md)의 탭 줄이 30초마다 `mods/schedules/schedules.cjs`를 불러 때가 된 예약을 실행합니다.
- 실행은 `hc run --bg`로 세션을 띄운 뒤 `hc send`로 프롬프트를 보냅니다.
- 예약과 실행 기록은 `<설정 폴더>/schedules/`에 남습니다([데이터가 저장되는 곳](../../herdr/README.md#데이터가-저장되는-곳)).

## 필요한 것

- Node.js
- 실행할 에이전트 CLI(`claude` 또는 `codex`)
- 함께 설치되는 모드: [패널 버튼](tabs-mine.md)

## 설치

```sh
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --add schedules
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -Add schedules
```

빼는 방법과 다른 옵션은 [모드 골라 설치](../../herdr/README.md#모드-골라-설치)에 있습니다.

---

[← 모드 목록으로](../../herdr/README.md#모드)
