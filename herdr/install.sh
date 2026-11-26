#!/bin/sh
# Herdr 모드를 설치·갱신한다(macOS·Linux). 다시 실행해도 된다.
#   기본 모드: tabs-mine, work, prs, wt-menu, schedules
#   추가 모드(--extras): usage-status, agent-groups, leader-tabs, path-menu, gh-accounts, inbox
#   인자 없이 실행하면 설치된 모드만 갱신한다(처음이면 기본 모드를 설치한다).
#   --only work,prs / --add usage-status / --remove leader-tabs / --list 로 모드를 고를 수 있다.
#   --statusline / --statusline-wrap 은 usage-status 의 사용률 기록기(usage-writer)를 Claude Code 상태 줄(statusLine)에 등록한다(켜겠다고 한 때만, 다른 상태 줄은 --wrap 없이는 바꾸지 않는다).
#     --only usage-status 처럼 모드 옵션과 함께 쓰거나 혼자 쓸 수 있고, --statusline-remove 는 등록을 뺀다.
#   --gh-account / --gh-account-uninstall 은 모드가 아니라 저장소별 GitHub 계정 도구(gh-account)를 설치·제거한다.
# 저장소를 받지 않고 바로 실행할 수도 있다.
#   curl -fsSL <저장소 raw 주소>/main/herdr/install.sh | sh
#   curl -fsSL <저장소 raw 주소>/main/herdr/install.sh | sh -s -- --extras
# Herdr 설정 폴더는 HERDR_APP_HOME, 없으면 ~/.config/herdr-app 이다.
# Herdr가 없거나 실행 중이 아니거나 레이아웃 단계가 실패해도 안내만 출력하고 0으로 끝난다.
set -e
REPO_URL="https://github.com/xowjd913/agent-mods"
BRANCH="main"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
OPT=""
VAL=""
SL=""

# 고르는 옵션은 하나만 받는다.
pick() {
  if [ -n "$OPT" ]; then echo "$OPT 와(과) $1 은(는) 함께 쓸 수 없습니다. 하나만 주세요."; exit 2; fi
  OPT="$1"
  VAL="$2"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --extras|--list|--gh-account|--gh-account-uninstall|--statusline-remove) pick "$1" "" ;;
    --statusline|--statusline-wrap) SL="$1" ;;
    --only|--add|--remove)
      if [ $# -lt 2 ]; then echo "$1 뒤에 모드 이름이 필요합니다(예: $1 work,prs)."; exit 2; fi
      pick "$1" "$2"
      shift ;;
    --only=*|--add=*|--remove=*) pick "${1%%=*}" "${1#*=}" ;;
    -h|--help)
      echo "사용법: sh install.sh [--extras | --only 모드,.. | --add 모드,.. | --remove 모드,.. | --list | --gh-account | --gh-account-uninstall] [--statusline | --statusline-wrap | --statusline-remove]"
      echo "  (인자 없음)  설치된 모드만 갱신한다. 처음이면 기본 모드를 설치한다."
      echo "  --extras     모든 모드(추가 모드 usage-status, agent-groups, leader-tabs, path-menu, gh-accounts, inbox 포함)를 설치한다."
      echo "  --only       고른 모드만 설치·갱신한다. 다른 설치된 모드는 그대로 둔다."
      echo "  --add        설치된 모드에 고른 모드를 더한다."
      echo "  --remove     고른 모드를 지우고 그 모드가 바꾼 레이아웃 블록을 되돌린다."
      echo "  --list       모드마다 설명과 설치 상태를 보여 준다."
      echo "  필요한 모드(예: prs에는 work)는 함께 설치한다."
      echo "  --statusline       usage-status 의 사용률 기록기를 Claude Code 상태 줄에 등록한다(없을 때만. 다른 상태 줄이 있으면 안내만 하고 바꾸지 않는다)."
      echo "  --statusline-wrap  있던 상태 줄 명령도 이어서 실행하도록 감싸서 등록한다. --statusline-remove 는 등록을 빼고 감싼 상태 줄을 되돌린다."
      echo "  --gh-account            저장소별 GitHub 계정 도구를 ~/.local/bin 에 설치한다(gh 래퍼, git 자격 증명 도우미, 커밋 신원)."
      echo "  --gh-account-uninstall  그 도구를 지우고 git 전역 설정의 gh-account 블록을 되돌린다. 매핑 파일은 남긴다."
      exit 0 ;;
    *) echo "알 수 없는 인자: $1 (sh install.sh --help)"; exit 2 ;;
  esac
  shift
done

case "$OPT" in --list|--gh-account|--gh-account-uninstall) NEED_HOME="" ;; *) NEED_HOME=1 ;; esac
if [ ! -d "$HOME_DIR" ] && [ -n "$NEED_HOME" ]; then
  echo "Herdr 설정 폴더($HOME_DIR)가 없어 건너뜁니다. Herdr 앱을 한 번 실행한 뒤 다시 실행하세요."
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node가 없어 설치하지 못했습니다. Node.js를 설치한 뒤 다시 실행하세요(Work·PRs 패널도 node가 필요합니다)."
  exit 0
fi

# 저장소 안에서 실행했으면 그 파일을 쓰고, 아니면(curl | sh) 압축 파일을 받아 임시 폴더에 푼다.
DIR=""
case "$0" in
  */install.sh|install.sh) DIR="$(cd "$(dirname "$0")" && pwd)" ;;
esac
if [ -z "$DIR" ] || [ ! -f "$DIR/install.cjs" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "내려받는 중: $REPO_URL ($BRANCH)"
  if ! curl -fsSL "$REPO_URL/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$TMP"; then
    echo "저장소를 내려받지 못했습니다. 네트워크를 확인한 뒤 다시 실행하세요."
    exit 0
  fi
  DIR="$(find "$TMP" -mindepth 2 -maxdepth 2 -type d -name herdr | head -n 1)"
  if [ -z "$DIR" ] || [ ! -f "$DIR/install.cjs" ]; then
    echo "내려받은 파일에서 herdr/install.cjs를 찾지 못했습니다."
    exit 0
  fi
fi

# gh-account 는 Herdr 모드가 아니라 따로 설치한다. 실패하면(다른 gh 파일이 이미 있음 등) 그 코드로 끝낸다.
if [ "$OPT" = "--gh-account" ] || [ "$OPT" = "--gh-account-uninstall" ]; then
  CMD=install
  [ "$OPT" = "--gh-account-uninstall" ] && CMD=uninstall
  HERDR_APP_HOME="$HOME_DIR" node "$DIR/gh-account/gh-account.cjs" "$CMD"
  exit $?
fi

# 목록과 제거는 레이아웃 복제가 필요 없어 여기서 끝난다. 도우미가 2로 끝나면(잘못된 이름 등) 2로 끝낸다.
if [ "$OPT" = "--list" ]; then
  node "$DIR/install.cjs" list --home "$HOME_DIR"
  exit 0
fi
if [ "$OPT" = "--remove" ]; then
  node "$DIR/install.cjs" remove --home "$HOME_DIR" --mods "$VAL" || {
    CODE=$?
    [ "$CODE" -eq 2 ] && exit 2
    echo "모드를 지우지 못했습니다."
  }
  case ",$VAL," in
    *,inbox,*) node "$DIR/install.cjs" hook --home "$HOME_DIR" --remove || echo "PO 훅을 설정에서 빼지 못했습니다." ;;
  esac
  case ",$VAL," in
    *,usage-status,*) node "$DIR/install.cjs" statusline --home "$HOME_DIR" --remove || echo "상태 줄 기록기를 설정에서 빼지 못했습니다." ;;
  esac
  exit 0
fi

# 상태 줄 기록기 등록만 하거나 빼는 경우는 모드 복사 없이 여기서 끝난다.
if [ "$OPT" = "--statusline-remove" ]; then
  node "$DIR/install.cjs" statusline --home "$HOME_DIR" --remove || echo "상태 줄 기록기를 설정에서 빼지 못했습니다."
  exit 0
fi
if [ -n "$SL" ] && [ -z "$OPT" ]; then
  set -- statusline --home "$HOME_DIR"
  [ "$SL" = "--statusline-wrap" ] && set -- "$@" --wrap
  node "$DIR/install.cjs" "$@" || echo "상태 줄 기록기를 설정에 넣지 못했습니다."
  exit 0
fi

# 1) 모드 복사
set -- mods --home "$HOME_DIR"
case "$OPT" in
  --extras) set -- "$@" --extras ;;
  --only|--add) set -- "$@" "$OPT" "$VAL" ;;
esac
# 사용률 기록기 등록은 usage-status 를 복사한 뒤 같은 도우미가 한다(켜겠다고 한 때만).
case "$SL" in
  --statusline) set -- "$@" --statusline ;;
  --statusline-wrap) set -- "$@" --statusline --wrap ;;
esac
node "$DIR/install.cjs" "$@" || {
  CODE=$?
  [ "$CODE" -eq 2 ] && exit 2
  echo "모드를 복사하지 못했습니다."
  exit 0
}
# PO 훅(inbox): Claude Code 설정(~/.claude/settings.json, CLAUDE_CONFIG_DIR이 있으면 그 폴더)의 Stop·UserPromptSubmit에 한 줄을 넣는다.
# 다른 훅은 건드리지 않고 쓰기 전에 백업한다. 실패해도 설치는 계속한다.
if [ -f "$HOME_DIR/mods/inbox/po-hook.cjs" ]; then
  node "$DIR/install.cjs" hook --home "$HOME_DIR" || echo "PO 훅을 설정에 넣지 못했습니다(PO 답이 UI 모드에 자동으로 올라오지 않습니다)."
fi
command -v gh >/dev/null 2>&1 || echo "gh가 없어 Work·PRs 패널은 GitHub 데이터를 불러오지 못합니다. GitHub CLI를 설치하고 로그인하세요."

# 2) 레이아웃. 우리 레이아웃이 없으면 실행 중인 앱에서 기본 레이아웃(main)을 복제한다.
NAME="$(node "$DIR/install.cjs" pending-layout --home "$HOME_DIR")" || NAME=""
if [ -z "$NAME" ]; then
  node "$DIR/install.cjs" layout --home "$HOME_DIR" || echo "레이아웃 단계를 마치지 못했습니다."
  exit 0
fi
if ! command -v herdr-app >/dev/null 2>&1 || ! herdr-app status >/dev/null 2>&1; then
  echo "실행 중인 Herdr 앱을 찾지 못해 레이아웃은 만들지 않았습니다. 앱을 켠 뒤 이 스크립트를 다시 실행하세요."
  exit 0
fi
OUT="$(herdr-app do layout.clone "{\"name\":\"main\",\"as\":\"$NAME\"}" 2>&1)" || {
  echo "layout.clone 실패: $OUT. 레이아웃은 만들지 않았습니다."
  exit 0
}
if [ ! -f "$HOME_DIR/layouts/$NAME.json" ]; then
  echo "layout.clone 뒤에도 $HOME_DIR/layouts/$NAME.json 이(가) 없습니다: $OUT"
  exit 0
fi
echo "레이아웃 생성: $HOME_DIR/layouts/$NAME.json (지금 이 레이아웃으로 바뀌었습니다. 다른 레이아웃으로 가려면 ctrl-shift-l)"
node "$DIR/install.cjs" layout --home "$HOME_DIR" --created || echo "레이아웃 단계를 마치지 못했습니다."
exit 0
