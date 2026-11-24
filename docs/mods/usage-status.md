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

### 읽는 파일

- `~/.claude/usage-limits.json`을 1분마다 읽기만 합니다.
- 네트워크 호출은 하지 않습니다.
- 이 파일은 Claude Code 상태 줄(statusline) 스크립트 등이 따로 써 줘야 합니다.
- 파일 형식:

  ```json
  { "updatedAt": "2026-01-01T09:00:00Z", "limits": [ { "kind": "five_hour", "percentUsed": 42 }, { "kind": "seven_day", "percentUsed": 16 } ] }
  ```

### 기본 상태 줄과의 차이

- Herdr 기본 상태 줄 모드를 복제해 사용률을 더한 것입니다.
- 사용률 정보가 없으면 기본 모드와 거의 같게 보입니다.

## 필요한 것

- `~/.claude/usage-limits.json`을 써 주는 도구
- 함께 설치되는 모드: 없음

## 설치

추가 모드라 기본 설치에는 들어가지 않습니다.

```sh
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --add usage-status
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -Add usage-status
```

빼는 방법과 다른 옵션은 [모드 골라 설치](../../herdr/README.md#모드-골라-설치)에 있습니다.

---

[← 모드 목록으로](../../herdr/README.md#모드)
