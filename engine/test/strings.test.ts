import { describe, expect, it } from "vitest";
import strings from "../content/strings.json";

/**
 * 문자열 키 — **화면이 쓰는 키가 실제로 테이블에 있어야 한다.**
 *
 * 없는 키를 쓰면 화면에 `res.cash` 같은 **키가 그대로 노출된다** — 실제로 그렇게
 * 배포 직전까지 갔다. 타입이 잡아 주지 않는 실수라 테스트로 막는다.
 *
 * 목록은 손으로 관리한다: 화면에서 문자열을 새로 쓸 때 여기 한 줄을 추가하는 것이
 * "원본에 그 키가 있는지" 확인하는 절차가 된다.
 */
const USED_BY_UI = [
  "cur.cash",
  "cur.scrap",
  "cur.parts",
  "cur.copper",
  "cur.boards",
  "run.smash",
  "run.strip",
  "find.title",
  "cond.sealedDesc",
  "cond.normal",
  "cond.flood",
  "cond.burnt",
  "cond.mint",
  "cond.sealed",
  "mach.1",
  "mach.2",
  "mach.3",
  "mach.high",
];

describe("문자열 테이블", () => {
  const ko = (strings as { ko: Record<string, string> }).ko;
  const en = (strings as { en: Record<string, string> }).en;

  it.each(USED_BY_UI)("화면이 쓰는 키 %s 가 테이블에 있다", (key) => {
    expect(ko[key], `한국어 테이블에 '${key}'가 없다 — 화면에 키가 그대로 노출된다`).toBeTruthy();
  });

  it("발견물 이름이 모든 발견물 id에 대해 있다", () => {
    // 발견물 id는 balance.json이 소유하고 이름은 Loc이 소유한다 — 둘이 어긋나면 안 된다
    const findIds = ["find-cash", "find-console", "find-parts", "find-coinbox", "find-keys", "find-letter", "find-toolbox"];
    for (const id of findIds) {
      expect(ko[`find.${id}`], `'find.${id}' 이름이 없다`).toBeTruthy();
    }
  });

  it("한국어와 영어 테이블의 키가 같다 — 나중에 언어를 붙일 때 구멍이 없어야 한다", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });
});
