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
