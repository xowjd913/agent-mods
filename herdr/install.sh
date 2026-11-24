#!/bin/sh
# Herdr 모드를 설치·갱신한다(macOS·Linux). 다시 실행해도 된다.
#   기본 모드: tabs-mine, work, prs, wt-menu, schedules
#   추가 모드(--extras): usage-status, agent-groups, leader-tabs
# 저장소를 받지 않고 바로 실행할 수도 있다.
#   curl -fsSL <저장소 raw 주소>/main/herdr/install.sh | sh
#   curl -fsSL <저장소 raw 주소>/main/herdr/install.sh | sh -s -- --extras
# Herdr 설정 폴더는 HERDR_APP_HOME, 없으면 ~/.config/herdr-app 이다.
# Herdr가 없거나 실행 중이 아니거나 레이아웃 단계가 실패해도 안내만 출력하고 0으로 끝난다.
set -e
REPO_URL="https://github.com/xowjd913/agent-mods"
BRANCH="main"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
EXTRAS=""

for a in "$@"; do
  case "$a" in
    --extras) EXTRAS="--extras" ;;
    -h|--help)
      echo "사용법: sh install.sh [--extras]"
      echo "  --extras  추가 모드(usage-status, agent-groups, leader-tabs)도 설치한다."
      exit 0 ;;
    *) echo "알 수 없는 인자: $a (sh install.sh --help)"; exit 2 ;;
  esac
done

if [ ! -d "$HOME_DIR" ]; then
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

# 1) 모드 복사
node "$DIR/install.cjs" mods --home "$HOME_DIR" $EXTRAS || { echo "모드를 복사하지 못했습니다."; exit 0; }
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
