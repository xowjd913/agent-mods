# 작업별 묶음 (agent-groups)

왼쪽 사이드바에서 터미널을 이슈 번호별로 묶고 리더를 맨 위에 둡니다.

![사이드바 작업별 묶음에서 리더 두 명 아래 #7·#8, #3 작업이 묶여 있고, 칸 머리줄에 리더 탭(문서·설치기)이 보이는 화면](../images/herdr-groups.png)

## 사용법

- **위치**: 왼쪽 사이드바
- **맞는 사람**: 에이전트를 역할별로 나눠 여러 이슈를 동시에 돌리는 사람

### 보기 고르기

- 사이드바 에이전트 목록에 `작업별 묶음` 보기가 생깁니다.
- Herdr 기본 보기(우선순위순, 공간별)도 그대로 고를 수 있습니다.

### 묶는 방법

- 터미널을 이슈 번호별로 묶고, 리더를 맨 위에 둡니다.
- 묶음은 두 가지로 정합니다.
  - 터미널 라벨: `role=po`, `role=leader`, `group-issue`, `session`
  - `hc` 이름: `dev-<이슈>`, `review-<이슈>`, `integration-<이슈>`

### 기본 목록과의 차이

- Herdr 기본 에이전트 목록 모드를 복제해 보기를 더한 것입니다.
- 위 라벨이나 이름이 없으면 기본 모드와 거의 같게 보입니다.

## 필요한 것

- 함께 설치되는 모드: 없음

## 설치

추가 모드라 기본 설치에는 들어가지 않습니다.

```sh
curl -fsSL https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.sh | sh -s -- --add agent-groups
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr/install.ps1))) -Add agent-groups
```

빼는 방법과 다른 옵션은 [모드 골라 설치](../../herdr/README.md#모드-골라-설치)에 있습니다.

---

[← 모드 목록으로](../../herdr/README.md#모드)
