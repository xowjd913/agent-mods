# 인박스 계약 v1

UI 모드(`inbox` 모드)가 읽는 파일의 규칙입니다. **이 규칙대로 파일을 쓰면 어떤 AI·스크립트든 데스크에 보고를 올리고 답을 받을 수 있습니다.** 특정 작업 방식(PO·리더 체계)을 따르지 않아도 됩니다. 이 문서만으로 쓰는 쪽을 만들 수 있게 썼습니다.

- 쓰는 도구: [`herdr/tools/inbox-write.cjs`](../herdr/tools/inbox-write.cjs) (의존성 없는 Node 스크립트, 파일 쓰기는 Windows 포함 — `hc label` 호출은 Windows 미검증)
- 읽는 쪽(데스크): [`docs/mods/inbox.md`](mods/inbox.md)
- 이 문서는 **현재 동작**을 적었습니다. 결정 카드의 선택지 파싱은 [#62](https://github.com/xowjd913/agent-mods/issues/62)에서 넓어질 수 있습니다.

## 1. 개념

| 개념 | 뜻 | 기본 프로필의 이름 |
|---|---|---|
| **에이전트** | 일을 하고 보고를 올리는 터미널(AI 세션). 파일 하나가 에이전트 하나입니다. | 리더 (`lead-<작업>` 이름) |
| **허브** | 에이전트의 보고를 받고 사람의 답을 전달받는 터미널. 사람이 데스크에서 고른 답이 이 터미널 입력창으로 들어갑니다. | PO (`role=po`, `po=<id>` 라벨) |
| **데스크** | 보고를 모아 보여 주고 답을 허브로 보내는 herdr 모드 | UI 모드 (`inbox`) |

흐름: 에이전트가 보고를 **파일에 한 줄 추가** → 데스크가 읽어 화면에 보임 → 결정·확인이 필요한 보고면 사람이 답 → 데스크가 **답 줄**을 허브 터미널에 입력 → 허브(AI)가 에이전트에게 전하고 → 에이전트가 `answered` 줄을 추가해 질문을 닫습니다.

"기본 프로필"은 지금까지 쓰던 이름들입니다. 이름(에이전트 이름 규칙, 라벨 이름 등)은 [프로필](#9-프로필)로 바꿀 수 있고, 아무것도 설정하지 않으면 이 문서의 기본값입니다. 아래 표기에서 `lead-*`, `role=po` 같은 것은 모두 기본 프로필의 이름입니다.

## 2. 파일 위치

데스크가 보는 폴더(이하 **인박스 폴더**)는 `HERDR_INBOX_DIR` 환경 변수, 없으면 `~/.herdr-inbox`(Windows는 `%USERPROFILE%\.herdr-inbox`)입니다.

| 파일 | 내용 |
|---|---|
| `<인박스 폴더>/<에이전트 이름>.jsonl` | 그 에이전트의 보고 줄들 |
| `<인박스 폴더>/po/<허브 id>.jsonl` | 허브가 데스크 채팅에 올린 말(`say`) |
| `<인박스 폴더>/profile.json` | (선택) 이름·라벨 설정, [프로필](#9-프로필) |

공통 규칙:

- 형식은 **JSON Lines**: 줄 하나가 JSON 객체 하나, UTF-8, 줄바꿈 `\n`. 객체 안의 줄바꿈은 `\n`으로 이스케이프합니다(`JSON.stringify` 결과를 그대로 쓰면 됩니다).
- **추가만** 합니다. 기존 줄을 고치거나 지우지 않습니다.
- 읽는 쪽은 **모르는 종류·모르는 필드·깨진 줄을 건너뜁니다.** 쓰다 만 마지막 줄(줄바꿈 없음)이 있어도 앞 줄들은 그대로 읽힙니다. 그래서 필드를 더하는 것은 호환됩니다.
- 쓰는 쪽은 마지막 줄이 줄바꿈으로 끝나지 않으면 먼저 줄바꿈을 붙이고 새 줄을 씁니다(쓰기 도구가 그렇게 합니다).
- 사람 계정 전용 파일이므로 파일은 `0600`, 폴더는 `0700`을 권장합니다(Windows는 해당 없음).
- 데스크는 파일 끝의 최대 1MiB만 읽고, 에이전트마다 최근 40줄만 채팅 보기에 둡니다.
- 에이전트 이름은 **파일 이름**이 됩니다. 영문자·숫자로 시작하고 영문자·숫자·`.`·`_`·`-`만, 64자 이하. 경로 구분자와 `..`은 안 됩니다.

## 3. 보고 줄

`<에이전트 이름>.jsonl`의 한 줄:

```json
{"v":1,"ts":"2026-01-01T09:00:00Z","leader":"lead-demo","terminal":"t12","kind":"decision","title":"[lead-demo] 결정","body":"어느 쪽으로 갈까요?\n1안: 지금 병합\n2안: 리뷰 후 병합\n추천: 2안","link":"https://github.com/owner/repo/pull/2","po":"main"}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `v` | 예 | 계약 버전, 지금은 `1` |
| `ts` | 예 | ISO 8601 시각(UTC 권장, 예 `2026-01-01T09:00:00Z`). 파싱이 안 되면 시각 없는 줄로 취급됩니다. |
| `leader` | 예 | 에이전트 이름. 파일 이름과 같게 씁니다. (필드 이름은 호환 때문에 `leader`로 고정입니다.) |
| `terminal` | 권장 | 에이전트의 터미널 id(예 `t12`). 데스크가 그 터미널과 줄을 이어 줍니다. |
| `kind` | 예 | 아래 종류표. 표에 없으면 줄 전체를 무시합니다. |
| `title` | 권장 | 한 줄 제목. 관례: `[<에이전트 이름>] <종류 말>` |
| `body` | 선택 | 본문(여러 줄 가능). 결정 카드는 [§6](#6-결정-카드) 형식 |
| `link` | 선택 | 사람이 볼 대상 주소(PR·이슈 URL 등). 없으면 빈 문자열 |
| `po` | 선택 | 이 보고를 받을 허브 id. 허브 id 규칙에 안 맞으면 없는 것으로 봅니다. |

### 종류(kind)

| kind | 언제 쓰나 | 사람의 응답 필요 |
|---|---|---|
| `start` | 일을 시작했다 | 아니오 |
| `done` | 일을 끝냈다 | 아니오 |
| `decision` | 사람이 **고를** 것이 있다 | **예** — `answered`가 올 때까지 열려 있음 |
| `verify` | 사람이 **직접 확인**해 줘야 한다 | **예** — `answered`가 올 때까지 열려 있음 |
| `stop` | 멈췄다(막힘·중단) | 아니오 |
| `resume` | 다시 시작했다 | 아니오 |
| `answered` | 열린 `decision`/`verify`에 답이 왔다 | 아니오(질문을 닫음) |
| `other` | 그 밖의 알림 | 아니오 |

### 열린 질문과 `answered`

- 데스크가 답을 기다리는 것으로 보는 질문은 **가장 새 `decision`/`verify` 한 줄**이고, 뒤에 `answered`가 오면 닫힙니다. 더 새 질문이 오면 옛 질문은 그것으로 대체됩니다.
- `answered`의 `body`에 닫을 종류(`decision` 또는 `verify`)를 적으면 그 종류의 가장 새 열린 질문을 닫습니다. `body`가 비어 있거나 다른 값이면 가장 새 열린 질문(종류 무관)을 닫습니다. `answered` 하나는 질문 하나만 닫습니다.
- 질문이 있었는데 `answered`를 안 쓰면 데스크에는 계속 답을 기다리는 것으로 남습니다. 그래서 답을 받으면 `answered`를 **꼭** 씁니다.

## 4. 허브 파일 (`say`)

허브가 데스크 채팅에 말을 올릴 때 `po/<허브 id>.jsonl`에 한 줄:

```json
{"ts":"2026-01-01T09:05:00Z","kind":"say","text":"배포는 내일 합니다.","to":"lead-demo"}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `ts` | 예 | 시각 |
| `kind` | 예 | `say` |
| `text` | 예 | 말. **2000자까지**, 비어 있으면 무시 |
| `to` | 선택 | 받는 에이전트 이름. 에이전트 이름 규칙에 맞아야 합니다. 없으면 전체에게 한 말 |

이 파일에는 `v`가 없습니다. (`me`, `img` 종류는 데스크의 PO 훅이 쓰는 것이라 쓰는 쪽이 만들 필요가 없습니다.)

허브 id는 소문자 영문·숫자·`-`, 1~40자입니다.

## 5. 라벨

데스크는 터미널의 **라벨**(`hc label`)도 봅니다. 터미널마다 붙이는 `이름=값` 문자열입니다. 파일만으로도 보고는 올라가지만, 라벨이 있어야 터미널 쪽 표시(대기 표시, 허브 찾기)가 맞습니다.

| 라벨 | 붙는 곳 | 값 |
|---|---|---|
| `role=po` | 허브 터미널 | 이 터미널이 허브다 |
| `po=<id>` | 허브 터미널 | 허브 id (위 규칙). `role=po`와 함께 있어야 인정 |
| `role=leader` | 에이전트 터미널 | 에이전트다(탭 정리 모드가 봄) |
| `wait=decision` / `wait=verify` | 에이전트 터미널 | 지금 이 종류의 답을 기다린다 |
| `wait-link=<url>` | 에이전트 터미널 | 기다리는 질문의 `link` |

- 에이전트 터미널의 **부모 터미널이 `role=po` 라벨**이어야 그 허브가 답을 받는 곳으로 인정됩니다. 이름이나 형제 터미널로 짐작하지 않습니다(엉뚱한 곳에 답이 들어가는 것을 막으려는 규칙).
- `decision`/`verify` 보고를 쓸 때 `wait=<종류>`, `wait-link=<link>`를 **함께** 붙이고, `answered`를 쓸 때 둘 다 비웁니다(`wait= wait-link=`). 쓰기 도구가 이것까지 해 줍니다(`--no-label`로 끌 수 있음).
- 에이전트 이름(`hc` 터미널 이름)은 기본 프로필에서 `lead-`로 시작합니다. 데스크의 대기 표시는 이 이름 규칙에 맞는 터미널만 셉니다.

## 6. 결정 카드

`decision` 보고의 `body`에 아래 줄이 있으면 데스크가 **선택 칩**(`N안 선택` 버튼)으로 보여 줍니다.

```text
어느 쪽으로 갈까요?
1안: 지금 병합
2안: 리뷰 후 병합
3안: 보류
추천: 2안
```

- 선택지 줄: `N안: 설명` — `N`은 **1~3**, 구분은 `:` `：` `)` 중 하나, 앞에 `- `나 `* `가 있어도 됩니다. 설명이 비면 줄로 치지 않습니다.
- 서로 다른 번호가 **2개 이상**이어야 칩이 나옵니다. 하나뿐이면 칩 없이 일반 답 입력만 나옵니다.
- 표시가 낀 선택지 줄: `1안(추천): 설명`, `1안 (추천): 설명`, `1안 [권장]: 설명`처럼 번호와 구분 사이의 짧은 괄호 표시도 선택지로 읽습니다. 그 표시(`추천`·`권장`)나 줄 끝의 `(추천)`·`★`은 그 선택지를 추천으로 가리키며, 칩에는 `1안 선택 (추천)`으로 보입니다(보내는 답은 `1안 선택` 그대로).
- 추천 줄(선택): `추천: N안` — 처음 나온 하나만 쓰고, 선택지 번호에 있어야 인정됩니다. 추천 칩은 강조됩니다.
- 질문이 여러 개일 때: `①`~`⑩` 중 하나로 시작하는 줄(`① 병합 시점`, `**② 순서**`, `- ③ …`)이 질문 머리줄이고, 그 아래 다음 머리줄까지의 `N안:` 줄이 그 질문의 선택지입니다. 데스크는 질문마다 버튼 한 줄을 따로 보여 주고, 질문마다 하나씩 고르면 답 `①1안, ②2안`(질문 순서)을 한 번에 보냅니다. 질문이 둘 이상이고 질문마다 선택지가 2개 이상일 때만 이렇게 읽고, 머리줄 위에 선택지 줄이 있거나 같은 머리 기호가 두 번 나오면 지금처럼 한 질문으로 읽습니다.
- 칩을 누르면 답은 `N안 선택`, `verify`는 `확인 완료`가 됩니다. 사람이 직접 쓴 답도 받습니다.

## 7. 답 줄

사람이 데스크에서 답하면 데스크가 **허브 터미널 입력창에 한 줄**을 넣습니다.

```text
Panel answer (decision) for lead-demo: "2안 선택". Target: https://github.com/owner/repo/pull/2
```

형식: `Panel answer (<decision|verify>) for <에이전트 이름>: "<답>".` + (`link`가 있으면) ` Target: <link>`.

허브가 AI라면 이 줄을 받아 **그 에이전트에게 답을 전하고**, 에이전트는 `answered` 줄을 씁니다. 허브 쪽 규칙(프롬프트)에 "`Panel answer (...) for X: "..."` 줄이 오면 X에게 전달하라"고 적어 두면 됩니다.

## 8. 쓰기 도구

```sh
# 보고 (결정이면 wait 라벨도 붙임)
node herdr/tools/inbox-write.cjs report --kind decision --agent lead-demo \
  --title "[lead-demo] 결정" --link https://github.com/owner/repo/pull/2 \
  --body $'어느 쪽으로?\n1안: 지금\n2안: 나중\n추천: 2안'
# $'...'는 bash/zsh 전용입니다. 다른 쉘(PowerShell, cmd, sh)에서는 아래처럼 파일이나 표준 입력으로 줍니다.
printf '어느 쪽으로?\n1안: 지금\n2안: 나중\n추천: 2안\n' > card.txt
node herdr/tools/inbox-write.cjs report --kind decision --agent lead-demo --title "[lead-demo] 결정" --file card.txt
printf '어느 쪽으로?\n1안: 지금\n2안: 나중\n' | node herdr/tools/inbox-write.cjs report --kind decision --agent lead-demo --title "[lead-demo] 결정" --file -

# 긴 본문은 파일이나 표준 입력(-)으로
node herdr/tools/inbox-write.cjs report --kind done --agent lead-demo --file report.md

# 답을 받은 뒤 (질문을 닫고 wait 라벨을 비움)
node herdr/tools/inbox-write.cjs answered --agent lead-demo --of decision

# 허브가 데스크 채팅에 말하기
node herdr/tools/inbox-write.cjs say --hub main --to lead-demo --text "배포는 내일 합니다."
```

- 에이전트 이름: `--agent` → `HERDR_INBOX_AGENT` → 이 터미널의 이름(`hc get $HC_TERMINAL_ID`) 순서. 기본 프로필의 말인 `--leader`, `--po`, `HERDR_INBOX_LEADER`도 같은 뜻입니다.
- 허브 id: `--hub`, 없으면 이 터미널의 부모가 `role=po` 라벨일 때 그 `po` 라벨. 둘 다 없으면 `po` 필드 없이 씁니다.
- `answered`는 `--of`·`--link`를 안 주면 이 터미널의 `wait`·`wait-link` 라벨에서 읽습니다.
- 종료 코드: `0` 썼음 / `1` 사용법·환경 오류(이름 규칙 위반, 프로필 오류 등) / `2` 내용 오류(없는 종류, 빈 글, 2000자 초과(UTF-16 단위로 셈, 이모지는 2 — 데스크가 같은 단위로 자르기 때문) — 아무것도 안 씀) / `4` 줄은 썼으나 `hc label` 실패(라벨은 손으로).
- Windows: 쓰기 도구는 `hc`를 실행 파일로 직접 부릅니다(`execFileSync("hc")`, 쉘 없음). `hc`가 `.cmd` 래퍼라면 찾지 못할 수 있고, 그 경우 줄은 쓰이지만 라벨은 `hc label`을 손으로 달아야 합니다(종료 코드 4). Windows는 **검증하지 않았습니다.** 쉘을 거치면 `--link` 같은 값이 명령어로 해석될 위험이 있어 `shell: true`로 우회하지 않았습니다.
- `hc`가 없어도 파일은 쓰입니다(`--agent`/`--terminal`을 직접 주면 `hc get`을 아예 부르지 않음). 라벨은 `hc label`이 있는 환경에서만 붙습니다.
- 도구 없이 직접 쓰려면 위 규칙대로 JSON 한 줄을 파일에 **추가**하면 됩니다. 쉘이라면:

  ```sh
  printf '%s\n' '{"v":1,"ts":"2026-01-01T09:00:00Z","leader":"lead-demo","terminal":"t12","kind":"done","title":"[lead-demo] 완료","body":"","link":""}' >> ~/.herdr-inbox/lead-demo.jsonl
  ```

## 9. 프로필

이름과 라벨을 내 방식대로 바꾸는 설정입니다. 위치: `HERDR_INBOX_PROFILE`이 가리키는 파일, 없으면 `<인박스 폴더>/profile.json`. **파일이 없으면 [`preset`](#프리셋-preset-124)이 정한 기본 프로필**입니다. 적지 않은 키는 그 프리셋의 값을 씁니다.

```json
{
  "v": 1,
  "preset": "none",
  "arrangeScript": "~/bin/my-arrange.sh",
  "agent": { "name": "^bot-[a-z0-9]+$", "role": "worker" },
  "hub": { "role": "desk", "idLabel": "room", "id": "^[a-z0-9]{1,12}$", "dir": "rooms" },
  "labels": { "role": "role", "wait": "needs", "waitLink": "needs-url" },
  "kinds": { "question": "decision", "review": "verify" }
}
```

| 키 | 기본값 | 뜻 |
|---|---|---|
| `preset` | 파일이 있으면 `po`, 파일이 없으면 자동 판별 | 기본 규칙 묶음: `po` 또는 `none` ([아래](#프리셋-preset-124)) |
| `arrangeScript` | `po`는 `~/.claude/skills/leader/herdr-team.sh`(파일이 있을 때만), `none`은 없음 | 리더 칸 정리 스크립트 경로. `~/`는 홈으로 풀립니다. `""`로 적으면 끕니다 |
| `agent.name` | `^lead-[a-z0-9_-]+$` | 에이전트 이름 규칙(정규식). 파일 이름 안전 규칙(§2)은 이것과 별개로 항상 적용 |
| `agent.role` | `leader` | 에이전트 터미널의 역할 라벨 값 |
| `hub.role` | `po` | 허브 터미널의 역할 라벨 값 |
| `hub.idLabel` | `po` | 허브 id가 적힌 라벨 이름 |
| `hub.id` | `^[a-z0-9-]{1,40}$` | 허브 id 규칙(정규식) |
| `hub.dir` | `po` | 허브 파일 폴더 이름(인박스 폴더 아래) |
| `labels.role` | `role` | 역할을 적는 라벨 이름 |
| `labels.wait` | `wait` | 대기 종류 라벨 이름 |
| `labels.waitLink` | `wait-link` | 대기 링크 라벨 이름 |
| `kinds` | `{}` | 별칭 → 계약 종류(`start` `done` `decision` `verify` `stop` `resume` `other`). 쓰기 도구가 별칭을 계약 종류로 바꿔 **파일에는 항상 계약 종류**가 적힙니다. |

### 프리셋 (`preset`, #124)

내 규칙이 따로 없는 사람이 설치만 해서 쓸 수 있게, 기본 이름 규칙을 묶음(프리셋) 둘로 나눴습니다. 키를 적으면 언제나 프리셋 위에 덮어씁니다.

| 프리셋 | 뜻 |
|---|---|
| `po` | 지금까지의 기본값입니다: `lead-*` 이름, `role=po` 허브, "리더 · " 머리말, 리더 칸 정리 스크립트 |
| `none` | 에이전트 이름·허브·머리말 규칙이 **하나도 없습니다.** 어떤 터미널도 리더나 허브로 알아보지 않습니다 |

- **고르는 순서**: ① 프로필의 `preset` 값 → ② 프로필 파일은 있는데 `preset`이 없으면 `po`(예전 프로필이 그대로 동작) → ③ 프로필 파일이 없으면 `~/.claude/skills/leader/herdr-team.sh`가 있을 때 `po`, 없을 때 `none`. 모르는 `preset` 값은 오류입니다.
- **`none`일 때 모드의 동작**: `agent-groups`는 `hc` 부모 관계로만 묶고(이슈 번호·`dev-N` 이름은 보지 않음), `leader-tabs`는 아무것도 보이지 않으며, `tabs-mine`은 이름과 상관없이 대기 라벨(`decision`·`verify`)이 붙은 터미널을 세고, `prs`는 칸 정리 기록을 쓰지 않으며, 인박스는 리더·허브를 알아보지 않습니다. 혼자 쓰는 데스크(#90)는 이 `none`에서 출발합니다.
- **내 규칙에 맞추기**: `{ "preset": "none", "agent": { "name": "^bot-" }, "hub": { "role": "desk" } }`처럼 필요한 키만 적습니다. 정리 스크립트가 있으면 `arrangeScript`에 경로를 적습니다. 그 파일이 없으면 정리 기능은 보이지 않습니다(리더 한 명만 직접 둡니다).
- `preset`이 `none`이면 `hub.role`을 비워 둘 수 있습니다. `po`에서 빈 `hub.role`은 예전처럼 오류입니다.

- 잘못된 프로필(JSON 오류, 모르는 버전, 깨진 정규식, 폴더 이름에 `/`나 `..`, 계약 종류를 별칭으로 덮어쓰기 등)은 **오류로 끝납니다.** 오타가 나도 조용히 기본 이름으로 쓰여 엉뚱한 파일이 생기는 일을 막습니다.
- 모르는 키는 무시합니다.
- **지금 적용 범위**: 쓰기 도구, 데스크(`inbox`: `inbox.cjs`·`main.js`), PO 훅(`po-hook.cjs`)은 프로필을 따릅니다. 한 로더(`herdr/mods/inbox/profile.cjs`)가 읽고, 데스크는 `node inbox.cjs`가 내는 JSON의 `names`로 받으며 프로필이 깨졌으면 화면에 오류 문구를 보이고 기본 이름으로 보여 줍니다(PO 훅은 깨진 프로필이면 아무것도 쓰지 않습니다). `tabs-mine`·`leader-tabs`·`agent-groups`·`work`·`prs`도 같은 이름 블록(모드는 `.cjs`를 `require`할 수 없어 파일마다 복사하고, 테스트가 한 글자도 다르지 않음을 지킵니다)으로 프로필을 따릅니다. 이름을 어디서 받는지는 [10.4](#104-다른-모드가-프로필을-받는-길)에 있습니다. 프로필을 바꾼 뒤에는 데스크(또는 `work` 패널)가 한 번 새로 읽어야 다른 모드에도 퍼집니다.

## 10. 데스크가 프로필을 읽게 하는 설계 (후속 PR)

> 이 절은 설계이고, ① 인박스 모드(`inbox.cjs`·`main.js`)와 `po-hook.cjs`는 구현됐습니다(`profile.cjs`). ② 나머지 모드(`leader-tabs`·`agent-groups`·`work`·`tabs-mine`·`prs`)도 구현됐습니다(10.4). 목표: 프로필 없이는 지금과 **똑같이** 동작하고, 프로필이 있으면 `lead-*`·`role=po`·"리더 · " 같은 이름 규칙 없이도 데스크가 끝까지 동작합니다. 구현하며 달라진 점: 화면 문구 키 `ui.hubName`/`ui.agentName`은 만들지 않았고(문구는 그대로), 에이전트 이름 기본값은 `^lead-[a-z0-9_-]+$`로 더 엄격해졌으며, `po-session` 폴더는 고정입니다. 기본 위치에 프로필이 없거나 그 경로가 폴더 아래가 아니면(ENOENT·ENOTDIR) 기본 프로필입니다.

### 10.1 읽는 쪽에 추가로 필요한 키

§9의 키에 더해 읽는 쪽만 쓰는 키입니다(쓰기 도구는 필요 없음). 기본값은 지금 코드의 값입니다.

| 키 | 기본값 | 쓰이는 곳 |
|---|---|---|
| `agent.titlePrefix` | `리더 · ` | 탭·창 제목에서 떼어 내는 접두어(`/^\s*리더\s*·\s*/`) |
| `agent.strip` | `^lead-` | 터미널 이름에서 표시 이름을 만들 때 떼는 접두어 |
| `labels.session` | `session` | 에이전트의 세션 이름 라벨 |
| `answerLine` | `Panel answer ({kind}) for {agent}: "{text}".{ Target: {link}}` | 허브로 보내는 답 줄(§7). 허브가 AI라 그쪽 규칙과 짝이 맞아야 함 |
| `ui.hubName` / `ui.agentName` | `PO` / `리더` | 화면 문구(`PO 모름`, `role=po` 안내 등) |

### 10.2 설정을 읽는 곳

한 곳(`loadProfile`)에서 읽어 각 모드에 넘깁니다(모드는 `.cjs`를 `require`할 수 없어 이름 블록을 복사해 쓰며, 지금은 구현됐습니다). 아래는 구현 전에 `herdr/` 전체를 `lead-`, `role=`, `po=`, `wait=`, `po/`, `리더`, `labels.role|wait|po|session`으로 다시 훑은 결과입니다(기준 커밋의 줄 번호). `install.cjs`에는 이런 이름이 없습니다.

| 규칙 | `inbox/inbox.cjs` | `inbox/main.js` | 그 밖 |
|---|---|---|---|
| 종류 집합 `KINDS` / `ASK_KINDS` | 10-11 | — | (계약 자체라 설정 대상 아님) |
| 대기 판정 `lead-*` + `wait` 라벨 | 759 | 50 | `tabs-mine/main.js:32`, 주석 173 |
| 표시 이름·세션 이름 (`리더 · ` 접두어, `lead-` 떼기, `labels.session`) | 767-770 | 58-61 | `leader-tabs/main.js:71-74`, `agent-groups/main.js:124-135`, `work/main.js:16-27`(같은 블록 복사, 테스트가 같음을 지킴), `tabs-mine/main.js:103`, `work/collect.cjs:212`(`labels.session`) |
| `/^lead-/` 에이전트 이름 검사 | 776, 953, 979, 1358, 1398, 1413 | 67, 175, 201, 580, 620, 635, 2348 | `leader-tabs/main.js:80`, `agent-groups/main.js:87,147-150,231-234`, `work/main.js:42`, `inbox/po-hook.cjs:99` |
| 허브 터미널 찾기 `labels.role === "po"` | 858-862 | 81-85 | `leader-tabs/main.js:129,170`(`roleOf(po) !== "po"`), `agent-groups/main.js:556` |
| 에이전트 역할 `role === "leader"` | 1257 | 479 | `leader-tabs/main.js:25,127,130,171`, `agent-groups/main.js:99,150,234`, **`prs/main.js:58`**(`labels.role === "leader"`로 리더 터미널 고름) |
| 답 줄 템플릿 | 866-868 | 88-90 | — |
| `@멘션` 정규식(`lead-`) | 875 | 97 | — |
| 허브 id 규칙·라벨 (`PO_ID`, `cleanPoId`, `isPoTerm`, `poId`) | 933-937 | 155-159 | `inbox/po-hook.cjs:100`(`I.poId`) |
| "PO 모름" 방 이름 `PO_OTHER` | 934 | 156 | — |
| 허브 폴더 `PO_DIR = "po"` (`<인박스>/po/<id>.jsonl` 읽기·목록) | 295, 540, 546 | — | `inbox/po-hook.cjs:10`(주석), 쓰기 도구는 이미 `hub.dir`를 따름 |
| 허브 노트 경로 `po/<id>.handoff.md` | 1789 (`handoffFile`) | 881(주석), 2094(화면에 보이는 경로 문자열) | — |
| `PO_SESSION_DIR = "po-session"` | 591, 671, 702 | — | `po-hook.cjs`(세션 파일 쓰기) |
| 화면 문구 (`NO_PO`, `role=po` 안내, `po=<id>` 툴팁, `리더` 단어) | — | 44, 46, 2359, 2409, 2431-2461, 2641-2654, 2844, 2864 | `leader-tabs`·`agent-groups`의 `리더 · ` 접두어 문구 |

**설정 대상이 아닌 것**: 타임라인 소유자 키 `who: "po"`(inbox.cjs 1001·1188·1282 등, main.js 223·410·504·2718·2748·2777)는 화면 안의 내부 키라 허브 이름과 무관합니다. `schedules.cjs`의 `"wait"`는 다른 CLI 옵션입니다.

**작업량 추정(PR 2)**: 고칠 파일은 **8개**(`inbox.cjs`, `inbox/main.js`, `po-hook.cjs`, `leader-tabs`, `agent-groups`, `work`(`main.js`+`collect.cjs`), `tabs-mine`, `prs`)이고 관련 줄은 약 **130개**입니다(이전 추정: 7개 파일·약 90줄). 늘어난 것은 `prs`·`po-hook`·`work/collect.cjs`와 `leader-tabs`·`agent-groups`의 역할 검사, 폴더 경로입니다. 복사된 이름 블록(`inbox.cjs`·`main.js`·`agent-groups`·`work`·`leader-tabs`)이 많아 한 로더로 모으는 일이 작업량의 대부분입니다. PR 하나로는 크니 ① 인박스 모드 + `po-hook` ② 나머지 모드(`leader-tabs`·`agent-groups`·`work`·`tabs-mine`·`prs`) 두 PR로 나누는 것을 권합니다.

### 10.3 동작 규칙(안)

- 프로필 위치와 오류 처리는 쓰기 도구와 같습니다(§9): 기본 위치에 파일이 없으면 기본 프로필, 깨진 파일이나 환경 변수가 가리키는 없는 파일은 오류(데스크는 오류 문구를 화면에 보이고 기본값으로 **조용히 대체하지 않음**).
- 파일 이름 안전 규칙(§2)은 프로필과 무관하게 항상 적용합니다.
- 복사된 로직은 한 모듈(`profile.cjs`)로 모읍니다. `main.js`가 `require`를 못 하는 제약은 `// names:begin`~`// names:end` 블록을 파일마다 복사하고, 테스트(`profile-share.test.cjs`)가 블록이 한 글자도 다르지 않음을 지키는 것으로 풀었습니다.
- 테스트: 기본 프로필 결과가 현재와 같음을 기존 테스트로 보장하고, `lead-*`도 `role=po`도 없는 프로필로 쓰기 도구 → 데스크 읽기 → 답 줄 생성 → `answered`까지 끝까지 도는 테스트를 더합니다.

### 10.4 다른 모드가 프로필을 받는 길

- **읽는 곳은 셋**: 데스크(`inbox`)는 `node inbox.cjs`가 내는 JSON의 `names`로, `work`와 `prs`는 `collect.cjs`가 같은 로더(설치기가 `work` 폴더에 `profile.cjs`를 함께 복사)로 읽어 낸 `names`로 받습니다. 셋 다 프로필이 깨졌으면 `profileError`로 이유를 알리고 기본 이름으로 보입니다. 이 가운데 하나라도 켜져 있으면 되고, 모두 없으면 기본 이름입니다.
- **나눠 쓰는 길**: 읽은 쪽(`inbox`·`work`·`prs`)이 공유 상태 `inbox.names`(프로필의 `names` JSON 그대로)에 올립니다(`adoptNames`). `leader-tabs`·`agent-groups`·`tabs-mine`·`prs`는 그릴 때와 타이머 때 이 키를 읽어 자기 이름 블록에 적용합니다(`syncNames`). 같은 내용이면 다시 쓰지 않습니다.
- **다른 공유 키와 섞이지 않습니다**: `inbox.po`는 고른 PO 방, `leader.names`는 리더 이름 기억, `inbox.names`는 프로필 이름입니다.
- **지금 한계**: 프로필 파일을 고친 뒤 `inbox`·`work`·`prs`가 다시 읽기 전까지는 옛 이름이 남습니다. 아직 프로필을 따르지 않는 곳은 **데스크의 PO 탭 이름에서 프로젝트 이름을 떼는 `/^PO\s*[·:\-]?\s*(\S.*)$/`(`inbox/main.js` `poProject`)** 하나입니다(PO 시작 흐름이 만드는 `PO · <프로젝트>` 탭 이름 규칙이고, 화면 문구 `PO`·`리더`는 프로필 대상이 아닙니다).
- **기본 이름이 조금 더 엄격해졌습니다**: 리더 이름 기본값이 `^lead-[a-z0-9_-]+$`라 대문자·점이 든 이름(`lead-Foo`, `lead-a.b`)은 이제 리더로 세지 않습니다. 인박스는 앞선 PR에서 이미 같은 규칙이고, `tabs-mine`·`leader-tabs`도 이제 같아졌습니다.
- **탭 이름 규칙**: `agent-groups`가 라벨 없는 터미널을 나눌 때 쓰는 탭 이름 규칙은 프로필의 허브 이름(`hub.role`을 대문자로 쓴 낱말, 기본 `PO`)과 접두어의 첫 낱말(`agent.titlePrefix`, 기본 `리더`)을 따르고, 리더 행 제목에는 접두어 글자 그대로(`names.titlePrefixText`)를 붙입니다. 세션 라벨 이름은 모든 모드에서 `labels.session`입니다.
