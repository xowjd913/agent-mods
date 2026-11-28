// "새 스페이스" 버튼(PO 목록 맨 위)의 순수 부분. Herdr 모듈을 불러오지 않아 테스트가 바로 불러 쓴다.
// 폴더 선택창은 macOS의 osascript만 쓴다(다른 OS에는 버튼을 보이지 않는다). 취소하면 osascript가 0이 아닌 코드로 끝난다.
export const PICK_FOLDER = ["-e", 'POSIX path of (choose folder with prompt "새 스페이스로 열 저장소 폴더를 고르세요")'];
// osascript 결과(exec 결과)에서 space.new 인자를 만든다. 취소·빈 출력이면 null. PO는 기존 `po` 실행 파일처럼 원격 제어를 켜고 /PO로 시작한다.
export function newSpaceArgs(r) {
  if (!r || r.code !== 0) return null;
  const path = String(r.stdout ?? "").trim().replace(/\/+$/, "");
  const name = path.split("/").filter(Boolean).pop();
  if (!path.startsWith("/") || !name) return null;
  return { name, folder: path, tab: `PO · ${name}`, argv: ["claude", "--remote-control", "PO"], task: "/PO" };
}
