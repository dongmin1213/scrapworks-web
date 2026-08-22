import { describe, expect, it } from "vitest";
import balanceJson from "../content/balance.json";
import { Balance, type BalanceData } from "../src/balance";
import { DotNetRandom } from "../src/rng";
import { newGame, sanitizeSave, Workshop } from "../src/workshop";
import { YardLine } from "../src/yardLine";

/**
 * 세이브 견고성 — **파싱이 됐다는 것은 아무것도 보장하지 않는다.**
 *
 * `JSON.parse`가 성공한 뒤 `{...기본값, ...파싱결과}`로 얹기만 하면
 * `{"codexIds": null}` 하나로 첫 렌더가 터지고 유저는 흰 화면을 본다 — 되돌릴 방법도 없다.
 * 여기서 검증하는 것은 "정상 저장이 복원된다"가 아니라 **"망가진 저장이 게임을 죽이지
 * 않는다"**이다. 전자는 쉬운 쪽이고, 실제로 사람을 잃는 것은 후자다.
 */

const balance = new Balance(balanceJson as unknown as BalanceData);

function fresh() {
  const w = new Workshop(balance, newGame(balance));
  return { w, line: new YardLine(balance, w, new DotNetRandom(1)) };
}

/** 밸런스까지 함께 돌려주는 리그 — 기대값을 테스트가 다시 계산하지 않게 한다. */
function freshWithBalance() {
  return { balance, ...fresh() };
}

describe("sanitizeSave — 망가진 저장을 받아도 게임은 계속된다", () => {
  it("정상 저장은 그대로 복원되고 intact다", () => {
    const { w } = fresh();
    w.earnCash(1234);
    w.earnScrap(56);
    w.addCodex(balance.find.items[0].id);
    const round = sanitizeSave(balance, JSON.parse(JSON.stringify(w.d)));
    expect(round.intact).toBe(true);
    expect(round.d).toEqual(w.d);
  });

  const broken: { name: string; raw: unknown }[] = [
    { name: "null", raw: null },
    { name: "배열", raw: [1, 2, 3] },
    { name: "문자열", raw: "wat" },
    { name: "codexIds가 null", raw: { codexIds: null } },
    { name: "codexIds가 숫자 배열", raw: { codexIds: [1, 2] } },
    { name: "nodeIds만 있고 nodeLevels가 없다", raw: { nodeIds: ["body-smash"] } },
    { name: "nodeLevels 길이가 다르다", raw: { nodeIds: ["body-smash", "body-strip"], nodeLevels: [3] } },
    { name: "존재하지 않는 노드 id", raw: { nodeIds: ["없는노드"], nodeLevels: [5] } },
    { name: "현금이 NaN", raw: { cash: Number.NaN } },
    { name: "현금이 Infinity", raw: { cash: Number.POSITIVE_INFINITY } },
    { name: "현금이 음수", raw: { cash: -999 } },
    { name: "maxGrade가 상한 초과", raw: { maxGrade: 99999 } },
    { name: "smashTier가 0", raw: { smashTier: 0 } },
    { name: "certs가 상한 초과", raw: { certs: 1e9 } },
    { name: "opEquipped가 보유 단수 초과", raw: { opRank: 1, opEquipped: 9 } },
  ];

  it.each(broken)("$name → 던지지 않고 온전한 SaveData를 만든다", ({ raw }) => {
    const { d } = sanitizeSave(balance, raw);
    // 실제로 게임을 굴려 본다 — 타입만 맞고 동작이 깨지면 의미가 없다
    const w = new Workshop(balance, d);
    const line = new YardLine(balance, w, new DotNetRandom(7));
    expect(() => {
      for (let i = 0; i < 600; i++) {
        line.buyOffer(1);
        line.tick(1 / 30);
      }
    }).not.toThrow();
    expect(Number.isFinite(w.cash)).toBe(true);
    expect(Array.isArray(w.d.codexIds)).toBe(true);
    expect(w.d.nodeIds.length).toBe(w.d.nodeLevels.length);
  });

  it("노드 레벨 상한을 넘겨도 상한으로 깎인다 — 조작 세이브의 주 통로", () => {
    const def = balance.skill.nodes[0];
    const { d, intact } = sanitizeSave(balance, {
      nodeIds: [def.id],
      nodeLevels: [def.max + 500],
    });
    expect(d.nodeLevels[0]).toBe(def.max);
    expect(intact).toBe(false);
  });

  it("도감에 없는 id는 떨어낸다 — 없는 패시브가 붙지 않게", () => {
    const { d } = sanitizeSave(balance, { codexIds: ["find-없는것", balance.find.items[0].id] });
    expect(d.codexIds).toEqual([balance.find.items[0].id]);
  });
});

describe("YardLine.restoreState — 진행 중인 작업이 새로고침을 넘긴다", () => {
  it("대기열·체력·컨베이어·모드·수령대기가 왕복한다", () => {
    const { w, line } = fresh();
    w.earnCash(1e6);
    w.d.maxGrade = 3;
    for (let i = 0; i < 3; i++) line.buyOffer(1);
    for (let i = 0; i < 200; i++) line.tick(1 / 30);
    line.setMode("strip");

    const saved = JSON.parse(JSON.stringify(line.saveState()));

    const w2 = new Workshop(balance, JSON.parse(JSON.stringify(w.d)));
    const line2 = new YardLine(balance, w2, new DotNetRandom(1));
    expect(line2.restoreState(saved)).toBe(true);

    expect(line2.queue.length).toBe(line.queue.length);
    expect(line2.mode).toBe(line.mode);
    expect(line2.conveyorT).toBeCloseTo(line.conveyorT, 12);
    expect(line2.queue.map((i) => [i.grade, i.conditionId, i.hp])).toEqual(
      line.queue.map((i) => [i.grade, i.conditionId, i.hp]),
    );
    expect(line2.offers).toEqual(line.offers);
  });

  const brokenLines: { name: string; raw: unknown }[] = [
    { name: "null", raw: null },
    { name: "queue가 null", raw: { queue: null } },
    { name: "queue에 null 원소", raw: { queue: [null] } },
    { name: "존재하지 않는 상태 id", raw: { queue: [{ grade: 1, conditionId: "없음", maxHp: 10, hp: 5 }] } },
    { name: "maxHp가 0", raw: { queue: [{ grade: 1, conditionId: "cond-normal", maxHp: 0, hp: 0 }] } },
    { name: "conveyorT가 NaN", raw: { conveyorT: Number.NaN } },
    { name: "존재하지 않는 발견물", raw: { pendingPickup: "find-없음", pendingPickupCash: 1e9 } },
  ];

  it.each(brokenLines)("$name → 던지지 않고 계속 굴러간다", ({ raw }) => {
    const { line } = fresh();
    expect(() => line.restoreState(raw)).not.toThrow();
    expect(() => {
      for (let i = 0; i < 300; i++) line.tick(1 / 30);
    }).not.toThrow();
    expect(Number.isFinite(line.conveyorT)).toBe(true);
  });

  it("smashDmg가 totalDmg를 넘는 세이브는 깎인다 — stripFrac 음수 방지", () => {
    const { w, line } = fresh();
    line.restoreState({
      queue: [
        { grade: 1, conditionId: "cond-normal", maxHp: 100, hp: 1, totalDmg: 50, smashDmg: 9999 },
      ],
      conveyorT: 1,
    });
    const it0 = line.queue[0];
    expect(it0.smashDmg).toBeLessThanOrEqual(it0.totalDmg);

    const before = w.scrap;
    for (let i = 0; i < 60; i++) line.tick(1 / 30);
    expect(w.scrap).toBeGreaterThanOrEqual(before); // 음수 정산이 나오지 않는다
  });
});

describe("난수 상태 왕복 — 새로고침으로 결과를 다시 뽑을 수 없다", () => {
  it("saveState/restore가 같은 수열을 잇는다", () => {
    const a = new DotNetRandom(12345);
    for (let i = 0; i < 37; i++) a.nextDouble();
    const b = DotNetRandom.restore(JSON.parse(JSON.stringify(a.saveState())));
    const seqA = Array.from({ length: 20 }, () => a.nextDouble());
    const seqB = Array.from({ length: 20 }, () => b.nextDouble());
    expect(seqB).toEqual(seqA);
  });

  it("망가진 난수 상태는 거부한다", () => {
    expect(DotNetRandom.isValidState(null)).toBe(false);
    expect(DotNetRandom.isValidState({ s: [1, 2], i: 0, p: 21 })).toBe(false);
    expect(DotNetRandom.isValidState({ s: Array(56).fill(0), i: 0, p: 21 })).toBe(true);
  });
});

/**
 * 세이브 일관성 — **"파싱된다"와 "규칙상 가능하다"는 다르다.**
 *
 * 앞의 검사들은 타입만 봤다. 그래서 등급 1000짜리 물건, 대기열 수천 개,
 * 조작된 maxHp, 범위 밖 난수 커서가 전부 통과했다 — 전부 규칙상 존재할 수 없는 상태다
 * (적대적 리뷰 R6).
 */
describe("세이브 일관성 — 규칙상 불가능한 상태는 받지 않는다", () => {
  it("등급 상한을 넘는 물건은 버린다 — 지수 수식이 Infinity로 간다", () => {
    const { line } = fresh();
    line.restoreState({
      offers: line.offers,
      queue: [{ grade: 1000, conditionId: "cond-normal", maxHp: 10, hp: 5 }],
      conveyorT: 1,
    });
    expect(line.queue).toHaveLength(0);
  });

  it("대기열 칸수를 넘기지 않는다", () => {
    const { line } = fresh();
    const many = Array.from({ length: 500 }, () => ({
      grade: 1,
      conditionId: "cond-normal",
      maxHp: 90,
      hp: 90,
    }));
    line.restoreState({ offers: line.offers, queue: many, conveyorT: 1 });
    expect(line.queue.length).toBeLessThanOrEqual(line.queueSlots);
  });

  it("조작된 maxHp는 등급·상태가 정하는 값으로 덮인다", () => {
    const { balance, line } = freshWithBalance();
    line.restoreState({
      offers: line.offers,
      // maxHp를 0.001로 낮추면 즉시 완료돼 무한 정산이 된다
      queue: [{ grade: 1, conditionId: "cond-normal", maxHp: 0.001, hp: 0.001 }],
      conveyorT: 1,
    });
    const expected = balance.durability(1) * balance.condition("cond-normal").durMult;
    expect(line.queue[0].maxHp).toBeCloseTo(expected, 9);
  });

  it("매대가 등급 1~6을 정확히 한 번씩 갖지 않으면 온전하지 않다고 본다", () => {
    const { line } = fresh();
    // 빈 배열도 배열이지만, 그러면 생성자가 만든 임시 매물이 남은 채 난수만 되감긴다
    expect(line.restoreState({ offers: [], queue: [], conveyorT: 0 })).toBe(false);
    expect(
      line.restoreState({
        offers: [{ grade: 1, conditionId: "cond-normal" }],
        queue: [],
        conveyorT: 0,
      }),
    ).toBe(false);
  });

  it("난수 커서가 범위를 벗어나면 거부한다 — NaN이 수열을 죽인다", () => {
    const valid = new DotNetRandom(1).saveState();
    expect(DotNetRandom.isValidState({ ...valid, i: 999 })).toBe(false);
    expect(DotNetRandom.isValidState({ ...valid, p: -20 })).toBe(false);
    expect(DotNetRandom.isValidState({ ...valid, s: valid.s.map(() => 2 ** 40) })).toBe(false);
    expect(DotNetRandom.isValidState(valid)).toBe(true);
  });
});
