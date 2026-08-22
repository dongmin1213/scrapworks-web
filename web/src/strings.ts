import table from "@scrapworks/engine/content/strings.json";

/**
 * 문자열 — 원본 `Loc.cs`에서 **기계로 추출한** 테이블을 쓴다 (손으로 옮겨 적지 않는다).
 * 옮겨 적으면 원본이 바뀌었을 때 조용히 갈라지고, 갈라진 것을 아무도 모른다.
 *
 * 언어는 지금 한국어 고정이다 — 원본은 ko/en 토글이 있지만 웹판 1단계 범위 밖이고,
 * 없는 기능을 있는 척 만들지 않는다. 테이블에는 en이 그대로 들어 있어 붙이기만 하면 된다.
 */
const ko = (table as { ko: Record<string, string> }).ko;

export function t(key: string): string {
  return ko[key] ?? key;
}
