# Claude 사용률 (usage-status)

아래 상태 줄 오른쪽에 Claude 5시간·7일 사용률을 막대로 보여 줍니다.

![아래 상태 줄 오른쪽에 Claude 5h 42%, 7d 16% 사용률이 가는 선 막대로 보이는 화면](../images/herdr-extras.png)

## 사용법

- **위치**: 아래 상태 줄
- **맞는 사람**: Claude 요금제 한도를 자주 확인하는 사람

### 보이는 것

- 5시간·7일 사용률 막대
- 80% 이상이면 경고 색으로 바뀝니다.
- 파일이 없거나 10분 넘게 갱신되지 않으면 `Claude Unknown`을 보여 줍니다.
  - 파일이 없으면 `Unknown · no usage file · install --statusline`처럼 켜는 방법을 함께 알려 줍니다.
  - 10분 넘게 갱신되지 않았으면 `Unknown · stale 20m`처럼 지난 시간을 알려 줍니다.

### 읽는 파일

- `~/.claude/usage-limits.json`을 1분마다 읽기만 합니다. 네트워크 호출은 하지 않습니다.
- 이 파일은 이 모드와 함께 설치되는 **기록기**(`usage-writer.cjs`)가 써 줍니다. 아래 [사용률 기록기 켜기](#사용률-기록기-켜기)를 보세요.
  - 같은 모양으로 쓰는 다른 도구가 이미 있으면 기록기를 켜지 않아도 됩니다.
- 파일 형식:

  ```json
  { "updatedAt": "2026-01-01T09:00:00Z", "limits": [ { "kind": "five_hour", "percentUsed": 42, "resetsAt": "2026-01-01T12:00:00Z" }, { "kind": "seven_day", "percentUsed": 16 } ], "costUsd": 1.23 }
  ```

### 사용률 기록기 켜기

Claude Code는 상태 줄 명령에 사용률을 JSON으로 넘겨 줍니다(`rate_limits.five_hour`·`seven_day`의 `used_percentage`·`resets_at`, `cost.total_cost_usd`).
기록기는 그 JSON을 받아 위 파일에 씁니다. 의존성이 없는 Node 스크립트 하나이고 macOS·Windows에서 같게 동작합니다.

- 설치 때 **켜겠다고 한 경우에만** Claude Code 설정(`~/.claude/settings.json`, `CLAUDE_CONFIG_DIR`이 있으면 그 폴더)의 `statusLine`에 등록합니다. 말하지 않으면 설정은 그대로입니다.
- 이미 쓰는 상태 줄이 있으면 **덮어쓰지 않습니다**. 안내만 하고 끝납니다.
  - `--statusline-wrap`(Windows는 `-StatusLineWrap`)을 주면 있던 상태 줄 명령을 그대로 이어서 실행하도록 감쌉니다. 원래 상태 줄 설정은 설정 파일 옆 `usage-writer-chain.json`에 보관하고, 뺄 때 되돌립니다.
  - 직접 하려면 상태 줄 스크립트가 받은 JSON을 `node "<설정 폴더>/mods/usage-status/usage-writer.cjs"`에도 넘기게 하세요.
- 설정 파일을 바꾸기 전에 `settings.json.bak-herdr-<시각>`으로 백업합니다. 다른 설정과 들여쓰기는 그대로 둡니다. JSON이 깨져 있으면 건드리지 않습니다.
- 이미 켜진 Claude Code 세션은 다시 시작해야 적용됩니다.
- 구독(Pro·Max·Ultra)이 아니거나 첫 응답 전에는 Claude Code가 `rate_limits`를 주지 않아 아무것도 쓰지 않습니다. 그동안은 `Unknown`입니다.

### 기본 상태 줄과의 차이

- Herdr 기본 상태 줄 모드를 복제해 사용률을 더한 것입니다.
- 사용률 정보가 없으면 기본 모드와 거의 같게 보입니다.

## 필요한 것

- Node.js (기록기가 씁니다)
- 함께 설치되는 모드: 없음

## 설치

추가 모드라 기본 설치에는 들어가지 않습니다.

```sh
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --add usage-status
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -Add usage-status
```

사용률 기록기까지 한 번에 켜려면 `--statusline`을 붙입니다(Windows는 `-StatusLine`). 이미 쓰는 상태 줄을 이어서 쓰려면 `--statusline-wrap`(`-StatusLineWrap`)입니다.

```sh
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --only usage-status --statusline
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -Only usage-status -StatusLine
```

이미 설치했다면 `--statusline`만 따로 줄 수 있고, `--statusline-remove`(`-StatusLineRemove`)나 `--remove usage-status`가 등록을 뺍니다.

빼는 방법과 다른 옵션은 [모드 골라 설치](../../herdr/README.md#모드-골라-설치)에 있습니다.

---

[← 모드 목록으로](../../herdr/README.md#모드)
