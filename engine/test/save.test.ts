import { describe, expect, it } from "vitest";
import balanceJson from "../content/balance.json";
import { Balance, type BalanceData } from "../src/balance";
import { DotNetRandom } from "../src/rng";
import {
  LEASE_TTL_MS,
  bootstrapMayWrite,
  canWriteSave,
  liveLeaseHolder,
  mayClaimLease,
  nextRevision,
  parseLease,
  serializeLease,
  shouldYieldSave,
} from "../src/saveLease";
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

/**
 * 저장 소유권 — **자기가 쓴 저장을 남의 것으로 오인하면 저장이 통째로 막힌다.**
 *
 * 실제로 그렇게 만들었다: 부팅이 쓴 저장에 훅과 다른 신원이 들어가, 첫 저장부터
 * 충돌로 판정돼 이후 아무것도 기록되지 않았다. 화면은 멀쩡히 돌았고 새로고침해야
 * 알 수 있었다 — 가장 나쁜 종류의 침묵이다 (적대적 리뷰 R6 수정 중 자초).
 */
describe("저장 소유권 — 누가 더 새것인가", () => {
  const me = { rev: 5, owner: "tab-A" };

  it("저장이 없으면 그냥 쓴다", () => {
    expect(shouldYieldSave(null, me)).toBe(false);
  });

  it("저장이 내 것보다 앞서면 양보한다 — 내가 낡았다", () => {
    expect(shouldYieldSave({ rev: 6, owner: "tab-B" }, me)).toBe(true);
  });

  it("저장이 내 것보다 뒤면 쓴다", () => {
    expect(shouldYieldSave({ rev: 4, owner: "tab-B" }, me)).toBe(false);
  });

  it("**동률이면 남이 쓴 것은 충돌이다** — 같은 리비전을 둘이 쓰면 하나가 사라진다", () => {
    expect(shouldYieldSave({ rev: 5, owner: "tab-B" }, me)).toBe(true);
  });

  it("동률이어도 **내가 쓴 것이면 계속 쓴다** — 이게 막히면 저장이 죽는다", () => {
    expect(shouldYieldSave({ rev: 5, owner: "tab-A" }, me)).toBe(false);
  });

  it("owner가 없는 옛 저장은 충돌이 아니다 — 아니면 업그레이드하는 모든 탭이 읽기전용이 된다", () => {
    expect(shouldYieldSave({ rev: 5 }, me)).toBe(false);
    expect(shouldYieldSave({ rev: 99 }, me)).toBe(true); // 다만 더 새것이면 여전히 양보한다
  });

  it("다음 리비전은 저장된 것보다 반드시 크다", () => {
    expect(nextRevision({ rev: 9 }, { rev: 5 })).toBe(10);
    expect(nextRevision({ rev: 2 }, { rev: 5 })).toBe(5);
    expect(nextRevision(null, { rev: 5 })).toBe(5);
  });
});

/**
 * 세이브 불변식 — **규칙이 만들 수 없는 상태는 규칙으로 되돌린다.**
 *
 * 타입·범위 검사만으로는 부족했다. `hp:0, totalDmg:0`은 두 값 모두 정상 범위지만
 * "아무 처리도 안 했는데 체력이 0"이라는 불가능한 상태이고, 다음 틱에 그대로 정산된다 —
 * 매입가만 내고 전액을 회수하는 무한 루프다 (적대적 리뷰 R7-16·17·18·19).
 */
describe("세이브 불변식", () => {
  it("hp + totalDmg는 항상 maxHp다 — 처리 없이 정산되지 않는다", () => {
    const { w, line } = fresh();
    line.restoreState({
      offers: line.offers,
      // 조작: 체력만 0으로 (처리는 안 했다고 주장)
      queue: [{ grade: 1, conditionId: "cond-normal", maxHp: 90, hp: 0, totalDmg: 0, findRolled: true }],
      conveyorT: 1,
    });

    const it0 = line.queue[0];
    expect(it0.hp + it0.totalDmg).toBeCloseTo(it0.maxHp, 9);
    // hp=0이면 totalDmg=maxHp — 즉 "다 처리했다"로 복원된다. 정산이 한 번은 일어나지만
    // 그건 실제로 다 부순 물건과 같은 상태이므로 반복 착취가 되지 않는다.
    expect(it0.totalDmg).toBeCloseTo(it0.maxHp, 9);
    expect(w.scrap).toBe(0); // 복원 자체는 자원을 만들지 않는다
  });

  it("발견 보상액은 저장값이 아니라 등급에서 다시 계산한다", () => {
    const { balance, line } = freshWithBalance();
    const findId = balance.find.items[0].id;
    line.restoreState({
      offers: line.offers,
      queue: [],
      conveyorT: 0,
      pendingPickup: findId,
      pendingPickupCash: 1e300, // 조작
      pendingPickupGrade: 1,
    });

    const expected = balance.yieldTotal(1) * (balance.findItemOf(findId)?.cashMult ?? 1);
    expect(line.pendingPickupCash).toBeCloseTo(expected, 6);
    expect(line.pendingPickupCash).toBeLessThan(1e6);
  });

  /**
   * **v3 세이브를 v4가 읽을 때 보상이 줄어들면 안 된다.**
   *
   * `pendingPickupGrade`를 추가하면서 SAVE_VERSION을 올리지 않았다. 이전 배포가 만든
   * 정상 v3 파일에는 그 필드가 없으므로 복원이 등급 1로 간주하고 금액을 다시 계산했고,
   * 고등급 발견물이 수령 대기인 사람의 보상이 **조용히 깎였다** (적대적 리뷰 R8-10).
   */
  it("v3 세이브의 고등급 수령 대기 보상이 깎이지 않는다", () => {
    const { balance, line } = freshWithBalance();
    const findId = balance.find.items[0].id;
    const cashMult = balance.findItemOf(findId)?.cashMult ?? 1;
    const grade = Math.min(7, balance.machine.gradeCap);
    const v3Cash = balance.yieldTotal(grade) * cashMult;

    // v3 파일 그대로 — pendingPickupGrade가 **없다**
    line.restoreState({
      offers: line.offers,
      queue: [],
      conveyorT: 0,
      pendingPickup: findId,
      pendingPickupCash: v3Cash,
    });

    expect(line.pendingPickupGrade).toBe(grade);
    expect(line.pendingPickupCash).toBeCloseTo(v3Cash, 6);
  });

  it("v3 세이브라도 어느 등급으로도 설명 안 되는 금액은 최소로 떨어진다", () => {
    const { balance, line } = freshWithBalance();
    const findId = balance.find.items[0].id;
    line.restoreState({
      offers: line.offers,
      queue: [],
      conveyorT: 0,
      pendingPickup: findId,
      pendingPickupCash: 1e300, // 위조 — v3에도 등급 필드가 없는 척한다
    });

    const floor = balance.yieldTotal(1) * (balance.findItemOf(findId)?.cashMult ?? 1);
    expect(line.pendingPickupGrade).toBe(1);
    expect(line.pendingPickupCash).toBeCloseTo(floor, 6);
  });

  it("v3은 읽을 수 있는 버전이라 '손상'으로 표시되지 않는다", () => {
    const { balance } = freshWithBalance();
    expect(sanitizeSave(balance, { version: 3 }).intact).toBe(true);
  });

  it("모르는 버전은 손상으로 표시된다", () => {
    const { balance } = freshWithBalance();
    expect(sanitizeSave(balance, { version: 99 }).intact).toBe(false);
  });

  it("매대는 한 칸만 손상돼도 전부 새로 굴린다 — 부분 적용이 시점을 어긋나게 한다", () => {
    const { line } = fresh();
    const saved = line.saveState();
    const broken = {
      ...saved,
      offers: saved.offers.map((o, i) => (i === 3 ? { ...o, conditionId: "cond-없음" } : o)),
    };

    const before = line.offers.map((o) => o.conditionId);
    expect(line.restoreState(broken)).toBe(false);
    // 부분 적용이 아니라 **손대지 않는다** — 생성자가 굴린 값 그대로다
    expect(line.offers.map((o) => o.conditionId)).toEqual(before);
  });

  it("난수 커서의 간격 21은 불변이다 — i===p면 0만 나오는 퇴화 수열이 된다", () => {
    const valid = new DotNetRandom(1).saveState();
    expect(DotNetRandom.isValidState({ ...valid, i: 1, p: 1 })).toBe(false);
    expect(DotNetRandom.isValidState({ ...valid, i: 5, p: 10 })).toBe(false);
    // 실제 생성기가 만든 상태는 여러 번 뽑아도 항상 통과해야 한다
    const rng = new DotNetRandom(4242);
    for (let i = 0; i < 200; i++) {
      rng.nextDouble();
      expect(DotNetRandom.isValidState(rng.saveState()), `${i}번째 표본 뒤 상태가 거부됐다`).toBe(true);
    }
  });
});

/**
 * 저장 권한 — <b>파일의 owner만으로는 못 막는 구멍.</b>
 *
 * 아직 아무도 쓰지 않은 파일에는 owner가 없어 두 탭이 모두 "충돌 아님"으로 판정하고
 * 같은 리비전을 쓴다. `navigator.locks`가 없는 브라우저에서는 그 창이 항상 열려 있다
 * (적대적 리뷰 R8-11). 리스 키가 그 경우를 닫는다.
 */
describe("canWriteSave", () => {
  it("리스를 잃은 탭은 종료 직전에도 쓰지 않는다", () => {
    expect(canWriteSave({ latched: true, leaseHolder: "me", myLeaseId: "me" })).toBe(false);
  });

  it("리스가 남의 것이면 쓰지 않는다 — owner 없는 첫 저장도 여기서 막힌다", () => {
    expect(canWriteSave({ latched: false, leaseHolder: "other", myLeaseId: "me" })).toBe(false);
  });

  it("리스가 내 것이면 쓴다", () => {
    expect(canWriteSave({ latched: false, leaseHolder: "me", myLeaseId: "me" })).toBe(true);
  });

  it("스토리지를 못 읽으면 혼자 도는 것으로 보고 쓴다 — 저장을 아예 못 하는 것보다 낫다", () => {
    expect(canWriteSave({ latched: false, leaseHolder: null, myLeaseId: "me" })).toBe(true);
  });

  it("owner 없는 저장에 두 탭이 붙어도 리스를 쥔 쪽만 쓴다", () => {
    const existing = { rev: 3 }; // owner 없음 — 구버전 세이브
    const a = { rev: 3, owner: "tab-A" };
    const b = { rev: 3, owner: "tab-B" };

    // owner 비교만으로는 둘 다 통과한다 — 이것이 구멍이었다
    expect(shouldYieldSave(existing, a)).toBe(false);
    expect(shouldYieldSave(existing, b)).toBe(false);

    // 리스 키가 하나의 답을 준다
    const holder = "tab-A";
    expect(canWriteSave({ latched: false, leaseHolder: holder, myLeaseId: a.owner })).toBe(true);
    expect(canWriteSave({ latched: false, leaseHolder: holder, myLeaseId: b.owner })).toBe(false);
  });
});

/**
 * 부팅이 야간 정산을 쓰는 자리 — <b>리스보다 먼저 돈다.</b>
 *
 * 탭 A가 게임을 소유한 채 두고 탭 B를 열면, B의 부팅이 리스를 주장하기도 전에 A의
 * 저장을 읽어 정산하고 <b>자기 이름으로 덮어썼다</b> (적대적 리뷰 R9-20).
 * 「리스 fail-closed」 검사는 그 뒤의 `writeSave`에만 있어서 이 창을 못 막았다.
 */
describe("bootstrapMayWrite", () => {
  it("주인이 이미 있으면 부팅은 쓰지 않는다", () => {
    expect(bootstrapMayWrite("tab-A", "tab-B")).toBe(false);
  });

  it("주인이 나면 쓴다 — 새로고침한 같은 탭이다", () => {
    expect(bootstrapMayWrite("tab-A", "tab-A")).toBe(true);
  });

  it("주인이 없으면 쓴다 — 첫 실행이거나 스토리지를 못 읽는다", () => {
    expect(bootstrapMayWrite(null, "tab-A")).toBe(true);
  });

  it("두 탭이 동시에 열려도 정산을 두 번 쓰지 않는다", () => {
    // A가 먼저 리스를 잡았다면 B의 부팅은 조용히 물러난다 —
    // B의 정산분은 메모리에만 남고, B가 실제로 리스를 얻으면 그때 기록된다
    const holder = "tab-A";
    expect(bootstrapMayWrite(holder, "tab-A")).toBe(true);
    expect(bootstrapMayWrite(holder, "tab-B")).toBe(false);
  });
});

/**
 * 리스 하트비트 — <b>살아 있는 주인에게서 뺏지 않는다.</b>
 *
 * 「누가 마지막에 썼나」로만 소유권을 보면 새 탭이 열리는 것만으로 소유권이 넘어갔고,
 * 그다음 밀린 부팅 저장이 <b>새 탭의 옛 메모리</b>를 최신 리비전으로 기록했다.
 * 원래 주인은 영구 읽기전용이 되고 그 탭의 진행이 사라졌다 (적대적 리뷰 R10-12).
 *
 * 그렇다고 「먼저 잡은 탭이 영원히 주인」이면 탭을 한 번 닫는 순간 게임이 통째로
 * 읽기 전용이 된다. <b>시각을 붙여 만료를 두는 것</b>이 그 둘 사이의 답이다.
 */
describe("리스 하트비트", () => {
  const NOW = 1_000_000;

  it("살아 있는 주인은 못 뺏는다 — 여기가 진행이 사라지던 자리다", () => {
    const alive = { id: "A", at: NOW - 1000 };
    expect(mayClaimLease(alive, "B", NOW)).toBe(false);
  });

  it("만료된 주인은 가져간다 — 탭을 닫았다고 게임이 영원히 잠기지 않게", () => {
    const dead = { id: "A", at: NOW - LEASE_TTL_MS };
    expect(mayClaimLease(dead, "B", NOW)).toBe(true);
  });

  it("내 리스는 언제나 갱신할 수 있다", () => {
    expect(mayClaimLease({ id: "me", at: 0 }, "me", NOW)).toBe(true);
  });

  it("아무도 없으면 가져간다", () => {
    expect(mayClaimLease(null, "me", NOW)).toBe(true);
  });

  it("살아 있는 주인만 주인으로 센다", () => {
    expect(liveLeaseHolder({ id: "A", at: NOW - 100 }, NOW)).toBe("A");
    expect(liveLeaseHolder({ id: "A", at: NOW - LEASE_TTL_MS }, NOW)).toBeNull();
    expect(liveLeaseHolder(null, NOW)).toBeNull();
  });

  it("왕복이 값을 보존한다", () => {
    const lease = { id: "abc", at: 12345 };
    expect(parseLease(serializeLease(lease))).toEqual(lease);
  });

  it("옛 형식(그냥 id 문자열)은 만료로 본다 — 안 그러면 그 값이 영원히 남아 아무도 못 쓴다", () => {
    const old = parseLease("legacy-tab-id");
    expect(old).toEqual({ id: "legacy-tab-id", at: 0 });
    expect(mayClaimLease(old, "me", NOW)).toBe(true);
  });

  it("빈 값과 깨진 값은 리스가 없는 것이다", () => {
    expect(parseLease(null)).toBeNull();
    expect(parseLease("")).toBeNull();
    expect(parseLease("{\"id\":123}")).toEqual({ id: "{\"id\":123}", at: 0 });
  });

  it("부팅은 살아 있는 주인이 있으면 쓰지 않는다", () => {
    const holder = liveLeaseHolder({ id: "A", at: NOW - 500 }, NOW);
    expect(bootstrapMayWrite(holder, "B")).toBe(false);

    // 주인이 조용해지면 써도 된다 — 경쟁자가 없다
    const gone = liveLeaseHolder({ id: "A", at: NOW - LEASE_TTL_MS - 1 }, NOW);
    expect(bootstrapMayWrite(gone, "B")).toBe(true);
  });
});

/**
 * <b>락 없는 브라우저에서 두 탭을 실제로 «엇갈리게» 돌려 본다.</b>
 *
 * README는 오래 「`navigator.locks` 미지원 환경에서 진행이 덮일 수 있다」고 적어 두었다(R12-12).
 * 그 문장은 리스에 하트비트·TTL이 붙기 «전»의 것이다 — 지금도 참인지 <b>말로 따지지 않고
 * 돌려서 본다</b>. 저장 경로는 순수 함수 넷으로 이루어져 있으므로 브라우저 없이 그 순서를
 * 그대로 흉내 낼 수 있다:
 *
 *   ① 리스를 읽는다(liveLeaseHolder) ② 써도 되는가(canWriteSave)
 *   ③ 저장을 읽는다 ④ 양보해야 하나(shouldYieldSave) → 쓴다(nextRevision)
 *
 * `navigator.locks`가 없으면 ①~⑤가 «한 덩어리»가 아니다. 그래서 최악의 끼어들기 —
 * <b>A가 리스를 읽은 «직후» B가 전부 해치우는</b> 순서 — 를 만들어 A가 B의 진행을
 * 덮는지 본다.
 */
describe("락 없는 두 탭 — 최악의 끼어들기", () => {
  const NOW = 1_000_000;

  /** localStorage 한 칸씩만 흉내 낸다 — 실제 저장 경로가 읽고 쓰는 것이 이 둘뿐이다. */
  interface World {
    lease: { id: string; at: number } | null;
    save: { rev: number; owner?: string } | null;
  }

  /**
   * 탭이 부팅할 때 드는 리비전 — <b>저장된 것보다 «하나 크다»</b> (`useGame`: `(file?.rev ?? 0) + 1`).
   *
   * 처음에 이걸 놓쳐서 「인수한 탭이 아무것도 못 쓴다」는 틀린 결론이 나왔다. 인수한 B가
   * 저장과 «같은» rev를 들고 있으면 <c>shouldYieldSave</c>가 「동률 = 충돌」로 막는 것이 맞다 —
   * 진짜 코드에서는 그런 상태가 나오지 않는다.
   */
  const bootRev = (world: World) => (world.save?.rev ?? 0) + 1;

  /** 한 탭의 저장 시도 — useGame.writeSave와 «같은 순서»다. */
  function attemptWrite(world: World, tab: { id: string; rev: number }, now: number): boolean {
    const holder = liveLeaseHolder(world.lease, now);                      // ①
    if (!canWriteSave({ latched: false, leaseHolder: holder, myLeaseId: tab.id })) return false; // ②
    const existing = world.save;                                            // ③
    if (shouldYieldSave(existing, { rev: tab.rev, owner: tab.id })) return false;                // ④
    world.save = { rev: nextRevision(existing, { rev: tab.rev }), owner: tab.id };               // ⑤
    return true;
  }

  it("A가 리스를 읽은 직후 B가 인수하고 저장해도, A가 B를 덮지 못한다", () => {
    // A가 주인이지만 하트비트가 끊긴 지 오래다(백그라운드 탭이 스로틀됐다)
    const world: World = { lease: { id: "A", at: NOW - LEASE_TTL_MS - 1 }, save: { rev: 5, owner: "A" } };

    // ── A가 ①을 막 지났다: 그 시점의 리스는 «만료»다 → A는 여기서 이미 못 쓴다
    const aHolderAtRead = liveLeaseHolder(world.lease, NOW);
    expect(aHolderAtRead).toBeNull();

    // ── B가 끼어들어 전부 해치운다: 인수 → 플레이 → 저장
    const bRev = bootRev(world); // B는 저장을 읽고 들어왔다 — rev 6
    expect(mayClaimLease(world.lease, "B", NOW)).toBe(true);
    world.lease = { id: "B", at: NOW };
    expect(attemptWrite(world, { id: "B", rev: bRev }, NOW)).toBe(true);
    expect(world.save).toEqual({ rev: 6, owner: "B" });

    // ── 이제 A가 ②~⑤를 마저 돌린다. **B의 저장을 덮으면 안 된다.**
    // A는 옛 세션이라 여전히 rev 6을 들고 있다(자기가 마지막에 쓴 5의 다음).
    expect(attemptWrite(world, { id: "A", rev: 6 }, NOW)).toBe(false);
    expect(world.save).toEqual({ rev: 6, owner: "B" });
  });

  it("«정말» 동시라도 리스를 쥔 쪽만 쓴다 — 리스가 유일한 직렬화 수단이다", () => {
    // 두 탭이 같은 저장 5에서 출발한다. owner 비교만으로는 둘 다 통과하던 자리(R6·R8-11).
    const world: World = { lease: { id: "B", at: NOW }, save: { rev: 5 } }; // owner 없는 구버전 저장

    expect(attemptWrite(world, { id: "A", rev: 6 }, NOW)).toBe(false); // 리스가 B다
    expect(attemptWrite(world, { id: "B", rev: 6 }, NOW)).toBe(true);
    expect(world.save).toEqual({ rev: 6, owner: "B" });
  });

  it("살아 있는 주인이 있으면 인수 자체가 안 된다 — 여기가 진행이 사라지던 자리다", () => {
    const world: World = { lease: { id: "A", at: NOW - 100 }, save: { rev: 5, owner: "A" } };

    expect(mayClaimLease(world.lease, "B", NOW)).toBe(false);
    expect(attemptWrite(world, { id: "B", rev: 1 }, NOW)).toBe(false);   // 낡은 메모리로 덮기 시도
    expect(world.save).toEqual({ rev: 5, owner: "A" });
  });

  it("주인이 탭을 닫아도 TTL이 지나면 풀린다 — 게임이 영원히 잠기지 않는다", () => {
    const world: World = { lease: { id: "A", at: NOW }, save: { rev: 5, owner: "A" } };

    const later = NOW + LEASE_TTL_MS + 1;
    expect(mayClaimLease(world.lease, "B", later)).toBe(true);
    world.lease = { id: "B", at: later };
    expect(attemptWrite(world, { id: "B", rev: bootRev(world) }, later)).toBe(true);
    expect(world.save).toEqual({ rev: 6, owner: "B" });
  });
});
