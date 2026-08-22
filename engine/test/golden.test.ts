import { describe, expect, it } from "vitest";
import fixtures from "../../golden/fixtures/core.json";
import balanceJson from "../content/balance.json";
import { Balance, type BalanceData } from "../src/balance";
import { DotNetRandom } from "../src/rng";
import { newGame, Workshop } from "../src/workshop";
import { YardLine } from "../src/yardLine";

/**
 * 골든 대조 — **원본과 값이 같은가.**
 *
 * 픽스처는 `golden/harness`가 만든다. 그 하네스는 원본 레포의 `Balance.cs`·`YardLine.cs`·
 * `Workshop.cs`를 **링크로 컴파일해 그대로 실행한다** — 수식을 옮겨 적지 않는다.
 *
 * **이전 버전은 그러지 않았고, 그래서 아무것도 잡지 못했다.** 픽스처 스크립트가 수식을
 * 전사하고 이 테스트가 같은 수식을 다시 전사하면, 둘이 똑같이 틀려도 101건이 전부
 * 통과한다(적대적 리뷰 R4). 실제로 매물 재고 누락과 `Random.Next` 스트림 오프셋이
 * 그렇게 통과했다. 그래서 지금 이 파일의 규칙은:
 *
 *   **테스트 안에서 게임 수식을 계산하지 않는다. 포팅한 클래스를 호출하고 결과만 본다.**
 */

const balance = new Balance(balanceJson as unknown as BalanceData);

/** 부동소수 비교 — 두 런타임의 double 연산은 IEEE754로 같지만 직렬화 왕복 오차만 허용한다. */
function expectClose(actual: number, expected: number, label: string) {
  const tolerance = Math.max(Math.abs(expected) * 1e-9, 1e-9);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    tolerance,
  );
}

describe("난수 — .NET System.Random을 정확히 재현한다", () => {
  it.each(fixtures.rngCases)("시드 $seed", ({ seed, doubles, ints }) => {
    const rd = new DotNetRandom(seed);
    for (let i = 0; i < doubles.length; i++) {
      expectClose(rd.nextDouble(), doubles[i], `시드 ${seed} nextDouble[${i}]`);
    }
    // **새 인스턴스**로 시작한다 — 원본 하네스가 `new Random(seed)`를 다시 만들기 때문.
    const ri = new DotNetRandom(seed);
    for (let i = 0; i < ints.length; i++) {
      expect(ri.next(100), `시드 ${seed} next(100)[${i}]`).toBe(ints[i]);
    }
  });
});

describe("등급 곡선 — 매입가·내구도·회수액·특수자원", () => {
  it.each(fixtures.formulas)(
    "등급 $grade",
    ({ grade, buyPrice, durability, yieldTotal, copper, boards, cores }) => {
      expectClose(balance.buyPrice(grade), buyPrice, `등급 ${grade} 매입가`);
      expectClose(balance.durability(grade), durability, `등급 ${grade} 내구도`);
      expectClose(balance.yieldTotal(grade), yieldTotal, `등급 ${grade} 회수액`);
      expectClose(balance.specialQty(balance.special.copperBase, grade), copper, "구리");
      expectClose(balance.specialQty(balance.special.boardsBase, grade), boards, "기판");
      expectClose(balance.specialQty(balance.special.coresBase, grade), cores, "코어");
    },
  );
});

describe("매물 상태 굴림 — YardLine.rollCondition을 그대로 호출한다", () => {
  it.each(fixtures.conditionRolls)("시드 $seed", ({ seed, rolled }) => {
    // 하네스도 이식본과 같은 지점에서 매대 6칸을 굴린 뒤 비교한다 — 스트림 오프셋이 맞아야 한다.
    const w = new Workshop(balance, newGame(balance));
    const line = new YardLine(balance, w, new DotNetRandom(seed));
    const actual = rolled.map(() => line.rollCondition());
    expect(actual).toEqual(rolled);
  });
});

describe("성장 곡선 — 노드·공구·작업자·인증 비용", () => {
  it.each(fixtures.progression.nodes)("노드 $id", ({ id, stat, per, max, costs }) => {
    const n = balance.skill.nodes.find((x) => x.id === id);
    expect(n, `노드 ${id}가 balance.json에 없다`).toBeDefined();
    expect(n!.stat).toBe(stat);
    expectClose(n!.per, per, `${id} per`);
    expect(n!.max).toBe(max);
    costs.forEach((c, lv) => expectClose(balance.nodeCost(n!, lv), c, `${id} lv${lv} 비용`));
  });

  it("공구 티어 비용", () => {
    for (const { tier, cost } of fixtures.progression.tools) {
      expectClose(balance.toolCost(tier), cost, `공구 T${tier}`);
    }
  });

  it("작업자 사다리 비용", () => {
    for (const { rank, cost } of fixtures.progression.operators) {
      expectClose(balance.operatorCost(rank), cost, `작업자 ${rank}단`);
    }
  });

  it("인증 — 상한이 배수 뒤집힘을 막는다", () => {
    for (const { cumScrap, certs, mult } of fixtures.progression.certs) {
      expect(balance.certsFrom(cumScrap), `누적 ${cumScrap} 인증`).toBe(certs);
      expectClose(balance.certMult(certs), mult, `인증 ${certs} 배수`);
    }
  });
});

describe("해체 정산 — YardLine이 실제로 지급한 자원을 잰다", () => {
  it.each(fixtures.settlements)(
    "등급 $grade · $condition · 뜯기비율 $stripFrac",
    ({ grade, condition, stripFrac, scrapGain, partsGain, cashGain, copperGain, boardsGain, coresGain, totalMachines }) => {
      const { w, line, it } = rig(grade, condition);

      it.findRolled = true; // 발견 난수를 배제해 정산만 관측한다 (하네스와 동일)
      it.totalDmg = it.maxHp;
      it.smashDmg = it.maxHp * (1 - stripFrac);
      it.hp = 0;

      const before = snapshotWallet(w);
      line.tick(1 / 30); // hp<=0 → complete → completeInner

      expectClose(w.scrap - before.scrap, scrapGain, "고철");
      expectClose(w.parts - before.parts, partsGain, "부품");
      expectClose(w.cash - before.cash, cashGain, "현금");
      expectClose(w.copper - before.copper, copperGain, "구리");
      expectClose(w.boards - before.boards, boardsGain, "기판");
      expectClose(w.cores - before.cores, coresGain, "코어");
      expect(w.d.totalMachines).toBe(totalMachines);
    },
  );
});

describe("발견 판정 — 400개 시드에서 몇 번 나오고 무엇이 나오는가", () => {
  it.each(fixtures.findChances)(
    "등급 $grade · $condition · 뜯기비율 $stripFrac",
    ({ grade, condition, stripFrac, trials, hits, byItem }) => {
      let actualHits = 0;
      const actualByItem: Record<string, number> = {};

      for (let seed = 1; seed <= trials; seed++) {
        let found: string | null = null;
        const { line, it } = rig(grade, condition, seed, (id) => {
          found = id;
        });
        it.totalDmg = it.maxHp;
        it.smashDmg = it.maxHp * (1 - stripFrac);
        it.hp = 0;
        line.tick(1 / 30);

        if (found !== null) {
          actualHits++;
          actualByItem[found] = (actualByItem[found] ?? 0) + 1;
        }
      }

      expect(actualHits, "발견 횟수").toBe(hits);
      expect(actualByItem).toEqual(byItem);
    },
  );

  it("뜯기가 부수기보다 발견이 잦다 — 이 게임의 코어 규칙", () => {
    const smash = fixtures.findChances.filter((f) => f.stripFrac === 0);
    const strip = fixtures.findChances.filter((f) => f.stripFrac === 1);
    const sum = (rows: typeof smash) => rows.reduce((n, f) => n + f.hits, 0);
    expect(sum(strip)).toBeGreaterThan(sum(smash));
  });
});

describe("시나리오 — 세션 전체를 원작과 나란히 돌린다", () => {
  // **여기가 진짜 방어선이다.** 개별 수식이 맞아도 호출 순서나 난수 소비 횟수가
  // 어긋나면 여기서 갈라진다 — 단위 픽스처가 절대 잡지 못하는 종류의 결함.
  it.each(fixtures.scenarios)(
    "$name",
    ({ seed, seconds, toggleEverySec, buyGrade, maxGrade, unlockHelper, startCash, dt, final, events, trace }) => {
      const w = new Workshop(balance, newGame(balance));
      w.d.maxGrade = maxGrade;
      w.earnCash(startCash);
      if (unlockHelper) {
        const n = balance.skill.nodes.find((x) => x.stat === "helper")!;
        w.d.nodeIds.push(n.id);
        w.d.nodeLevels.push(1);
      }

      const seenEvents: { t: string; [k: string]: unknown }[] = [];
      const rng = new DotNetRandom(seed);
      const line = new YardLine(balance, w, rng, {
        onFind: (id) => seenEvents.push({ t: "find", id }),
        onItemDone: (it) => seenEvents.push({ t: "done", grade: it.grade, cond: it.conditionId }),
      });

      // **dt를 float32로 되돌린다.** 하네스의 DT는 `1f/30f`(float)이고 JSON에는 그 값의
      // 최단 왕복 표기("0.033333335")로 실린다. 그대로 double로 읽으면 원작이 실제로 쓴
      // 0.0333333350718…와 미세하게 다르고, 12스텝만 누적해도 totalDmg가 갈라진다.
      const step = Math.fround(dt);
      const steps = Math.round(seconds / step);
      const togglePeriod = toggleEverySec > 0 ? Math.round(toggleEverySec / step) : 0;
      let traceIdx = 0;

      for (let i = 0; i < steps; i++) {
        if (line.buyOffer(buyGrade)) seenEvents.push({ t: "buy", grade: buyGrade });
        if (togglePeriod > 0 && i > 0 && i % togglePeriod === 0) line.toggleMode();

        line.tick(step);
        if (line.pendingPickup) line.claimFind();

        if (i % 30 === 0) {
          const want = trace[traceIdx++];
          if (want) expectSnapshot(w, line, want, `t=${want.sec}s`);
        }
      }

      expectClose(w.cash, final.cash, "최종 현금");
      expectClose(w.scrap, final.scrap, "최종 고철");
      expectClose(w.parts, final.parts, "최종 부품");
      expectClose(w.copper, final.copper, "최종 구리");
      expectClose(w.boards, final.boards, "최종 기판");
      expectClose(w.cores, final.cores, "최종 코어");
      expectClose(w.d.cumScrap, final.cumScrap, "누적 고철");
      expectClose(w.d.lifetimeCash, final.lifetimeCash, "누적 현금");
      expect(w.d.codexIds).toEqual(final.codexIds);
      expect(w.d.findCount).toBe(final.findCount);
      expect(w.d.totalMachines).toBe(final.totalMachines);
      expect(w.d.maxGrade).toBe(final.maxGrade);
      expect(line.queue.length).toBe(final.queue);
      expect(line.mode).toBe(final.mode.toLowerCase());
      expect(seenEvents).toEqual(events);
    },
  );
});

// ─────────────────────────── 리그 ───────────────────────────

function snapshotWallet(w: Workshop) {
  return {
    cash: w.cash,
    scrap: w.scrap,
    parts: w.parts,
    copper: w.copper,
    boards: w.boards,
    cores: w.cores,
  };
}

/** 정산·발견 관측용 리그 — 하네스의 `Rig()`와 같은 순서로 난수를 쓴다. */
function rig(grade: number, condition: string, seed = 1, onFind?: (id: string) => void) {
  const w = new Workshop(balance, newGame(balance));
  w.d.maxGrade = balance.machine.gradeCap;
  w.earnCash(1e12); // 매입가 제약 제거 (정산 관측이 목적)
  const rng = new DotNetRandom(seed);
  const line = new YardLine(balance, w, rng, { onFind }); // 생성자가 매대 6칸을 굴린다
  if (!line.buy(grade, condition)) throw new Error(`매입 실패: g${grade} ${condition}`);

  for (let i = 0; i < 10_000 && !line.working; i++) line.tick(1 / 30);
  if (!line.working) throw new Error("컨베이어가 끝나지 않았다");
  return { w, line, it: line.current! };
}

function expectSnapshot(
  w: Workshop,
  line: YardLine,
  want: Record<string, number | string | boolean | null>,
  label: string,
) {
  expectClose(w.cash, want.cash as number, `${label} 현금`);
  expectClose(w.scrap, want.scrap as number, `${label} 고철`);
  expectClose(w.parts, want.parts as number, `${label} 부품`);
  expectClose(w.copper, want.copper as number, `${label} 구리`);
  expectClose(w.boards, want.boards as number, `${label} 기판`);
  expectClose(w.cores, want.cores as number, `${label} 코어`);
  expectClose(w.d.cumScrap, want.cumScrap as number, `${label} 누적고철`);
  expectClose(w.d.lifetimeCash, want.lifetimeCash as number, `${label} 누적현금`);
  expect(line.queue.length, `${label} 대기열`).toBe(want.queue);
  expectClose(line.conveyorT, want.conveyorT as number, `${label} 컨베이어`);
  expect(line.mode, `${label} 모드`).toBe((want.mode as string).toLowerCase());
  expect(line.working, `${label} 가동`).toBe(want.working);
  expect(w.codexCount, `${label} 도감`).toBe(want.codex);
  expect(w.d.findCount, `${label} 발견수`).toBe(want.finds);
  expect(w.d.maxGrade, `${label} 최고등급`).toBe(want.maxGrade);
  expect(w.d.totalMachines, `${label} 처리대수`).toBe(want.totalMachines);

  const cur = line.current;
  if (want.hp === null) {
    expect(cur, `${label} 작업물 없음`).toBeNull();
  } else {
    expect(cur, `${label} 작업물 있음`).not.toBeNull();
    expectClose(cur!.hp, want.hp as number, `${label} hp`);
    expectClose(cur!.maxHp, want.maxHp as number, `${label} maxHp`);
    expectClose(cur!.totalDmg, want.totalDmg as number, `${label} totalDmg`);
    expectClose(cur!.smashDmg, want.smashDmg as number, `${label} smashDmg`);
    expect(cur!.revealed, `${label} 개봉`).toBe(want.revealed);
  }
}
