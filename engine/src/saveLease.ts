/**
 * 저장 소유권 판정 — **어느 저장이 더 새것인가.**
 *
 * 두 탭이 같은 localStorage를 쓰면 나중에 쓴 쪽이 앞의 진행을 덮는다. 리비전만 비교하면
 * 동률에서 둘 다 통과하므로(같은 저장 N에서 출발하면 둘 다 N+1을 든다), 리비전에
 * **누가 썼는지**를 함께 본다.
 *
 * **왜 순수 함수로 빼는가**: 이 판정을 훅 안에 두었더니 자기 부팅 저장을 남의 것으로
 * 오인해 **저장이 통째로 막혔다.** 화면은 멀쩡히 돌았고 새로고침해야 알 수 있었다.
 * 브라우저 없이 돌릴 수 있는 자리로 옮겨야 그런 것을 테스트가 잡는다.
 */

export interface SaveOwnership {
  rev: number;
  /** 이 저장을 쓴 탭. 옛 세이브에는 없다(그 필드가 생기기 전에 쓰였다). */
  owner?: string;
}

/**
 * 지금 쓰면 남의 진행을 덮는가.
 *
 * - 저장된 리비전이 **내 것보다 앞서면** 내가 낡았다 → 양보한다.
 * - **동률**이면 누가 썼는지를 본다. 남이 썼으면 양보한다(동률이 곧 충돌이다).
 * - `owner`가 없는 저장은 **이 필드가 생기기 전의 것**이다. 남의 것으로 볼 근거가 없고,
 *   그렇게 보면 업그레이드하는 모든 탭이 영구히 읽기 전용이 된다 — 실제로 그랬다.
 */
export function shouldYieldSave(existing: SaveOwnership | null, mine: { rev: number; owner: string }): boolean {
  if (!existing || typeof existing.rev !== "number") return false;
  if (existing.rev > mine.rev) return true;
  if (existing.rev < mine.rev) return false;
  // 동률 — owner가 있고 내 것이 아니면 남이 방금 썼다
  return typeof existing.owner === "string" && existing.owner !== mine.owner;
}

/** 다음 리비전 — 저장된 것보다 반드시 커야 한다. */
export function nextRevision(existing: SaveOwnership | null, mine: { rev: number }): number {
  return Math.max(mine.rev, (existing?.rev ?? 0) + 1);
}

/**
 * 지금 이 탭이 저장을 써도 되는가 — <b>owner 비교로는 못 막는 구멍을 닫는다.</b>
 *
 * <code>shouldYieldSave</code>는 저장 파일의 <code>owner</code>를 보는데, 아직 아무도
 * 쓰지 않은 파일(첫 저장·구버전 세이브)에는 그 필드가 없다. 그러면 두 탭이 모두
 * "충돌 아님"으로 판정하고 같은 리비전을 쓴다 (적대적 리뷰 R8-11).
 *
 * 리스 키는 <b>누가 마지막에 주장했는지</b>를 하나의 값으로 답하므로 그 경우를 닫는다.
 * <code>navigator.locks</code>가 없는 브라우저에서는 이것이 유일한 직렬화 수단이다 —
 * 완전한 CAS는 아니지만, 소유자가 아닌 탭이 쓰지 않는 것만으로 대부분의 덮어쓰기가 사라진다.
 *
 * @param latched 이미 소유권을 잃은 탭인가 (한 번 잃으면 새로고침 전까지 되찾지 않는다)
 * @param leaseHolder 리스 키에 적힌 값. 스토리지를 못 읽으면 null — 혼자 도는 것으로 본다.
 */
export function canWriteSave(
  { latched, leaseHolder, myLeaseId }: { latched: boolean; leaseHolder: string | null; myLeaseId: string },
): boolean {
  if (latched) return false;
  if (leaseHolder === null) return true;
  return leaseHolder === myLeaseId;
}

/**
 * 부팅이 야간 정산 결과를 <b>써도 되는가</b>.
 *
 * 부팅은 React 이펙트가 리스를 주장하기 <b>전에</b> 돈다. 그래서 오프라인 시간이 있으면
 * `nightCash > 0` 경로가 현재 소유자를 확인하지 않고 새 owner/rev로 저장을 덮어썼다:
 * 탭 A가 게임을 소유한 채 두고 탭 B를 열면, B가 리스를 주장하기도 전에 A의 저장을
 * 읽어 정산하고 <b>자기 이름으로 덮어썼다</b> (적대적 리뷰 R9-20).
 * 「리스 fail-closed」 검사는 그 뒤의 `writeSave`에만 있었다.
 *
 * 규칙은 단순하다: <b>주인이 이미 있으면 부팅은 쓰지 않는다.</b> 정산 결과는 메모리에만
 * 두고, 리스를 실제로 얻은 뒤 평상시 저장 경로가 기록한다. 주인이 없으면(첫 실행·
 * 스토리지 없음) 써도 된다 — 그때는 경쟁자가 없다.
 *
 * @param leaseHolder 리스 키에 적힌 값. 못 읽으면 null(혼자 도는 것으로 본다).
 * @param myLeaseId 이 탭이 쓰려는 신원.
 */
export function bootstrapMayWrite(leaseHolder: string | null, myLeaseId: string): boolean {
  return leaseHolder === null || leaseHolder === myLeaseId;
}
