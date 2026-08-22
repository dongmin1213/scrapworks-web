import { describe, expect, it } from "vitest";
import fixtures from "../../golden/fixtures/core.json";
import balanceJson from "../content/balance.json";
import { Balance, type BalanceData } from "../src/balance";
import { DotNetRandom } from "../src/rng";
import type { Rng } from "../src/rng";
import { newGame, Workshop } from "../src/workshop";
import { YardLine } from "../src/yardLine";

/**
 * 뮤테이션 테스트 — **골든이 정말 결함을 잡는가.**
 *
 * 통과하는 골든은 두 가지 중 하나다: 이식이 맞거나, **골든이 아무것도 보고 있지 않거나.**
 * 이 레포는 후자를 이미 한 번 겪었다 — 픽스처 스크립트가 수식을 전사하고 테스트가 같은
 * 수식을 다시 전사해, 매물 재고 누락과 난수 스트림 어긋남을 안은 채 101건이 전부 통과했다.
 *
 * 그래서 여기서는 **일부러 망가뜨린 엔진**을 같은 골든에 넣고 **반드시 실패해야 한다**고
 * 주장한다. 이 파일이 통과한다는 것은 곧 golden.test.ts의 통과가 의미를 가진다는 뜻이다.
 *
 * 각 케이스는 실제로 있었거나 있을 법한 결함을 그대로 재현한다.
 */

const balance = new Balance(balanceJson as unknown as BalanceData);
const scenario = fixtures.scenarios.find((s) => s.name === "helper-lane")!;

/** 시나리오를 끝까지 돌리고 최종 상태를 돌려준다 — 골든이 대조하는 것과 같은 값들. */
function runScenario(mutate: Mutation = {}): Outcome {
  const w = new Workshop(balance, newGame(balance));
  w.d.maxGrade = scenario.maxGrade;
  w.earnCash(scenario.startCash);

  if (scenario.unlockHelper && !mutate.dropHelperNode) {
    const n = balance.skill.nodes.find((x) => x.stat === "helper")!;
    w.d.nodeIds.push(n.id);
    w.d.nodeLevels.push(1);
  }

  const rng: Rng = new DotNetRandom(scenario.seed);
  const finds: string[] = [];
  const line = new YardLine(balance, w, rng, { onFind: (id) => finds.push(id) });

  const step = Math.fround(scenario.dt);
  const steps = Math.round(scenario.seconds / Math.fround(scenario.dt));
  const togglePeriod = Math.round(scenario.toggleEverySec / Math.fround(scenario.dt));

  for (let i = 0; i < steps; i++) {
    if (mutate.rollOnEveryPress) {
      // **원래 있던 결함**: 누를 때마다 상태를 굴리고 그걸로 산다.
      // 실패해도 난수를 이미 써 버려서 이후 발견물 난수가 전부 한 칸씩 밀린다.
      const cond = line.rollCondition();
      line.buy(scenario.buyGrade, cond);
    } else {
      line.buyOffer(scenario.buyGrade);
    }

    if (mutate.extraRngPerStep) rng.nextDouble(); // 난수 한 번 더 소비

    if (togglePeriod > 0 && i > 0 && i % togglePeriod === 0) line.toggleMode();
    if (mutate.splitTick) {
      // 같은 시간을 두 번에 나눠 진행한다 — "고정 스텝으로 쪼개면 더 정확하다"는 흔한 오해.
      // 발견 판정(누적 데미지 50%)이 걸리는 프레임이 달라지고 난수 소비가 어긋난다.
      line.tick(step / 2);
      line.tick(step / 2);
    } else {
      line.tick(step);
    }
    if (line.pendingPickup && !mutate.skipClaim) line.claimFind();
  }

  return {
    cash: w.cash,
    scrap: w.scrap,
    parts: w.parts,
    cumScrap: w.d.cumScrap,
    totalMachines: w.d.totalMachines,
    maxGrade: w.d.maxGrade,
    codexIds: [...w.d.codexIds],
    findCount: w.d.findCount,
    finds,
  };
}

interface Mutation {
  /** 매대 재고를 무시하고 누를 때마다 굴린다 (실제로 있었던 결함) */
  rollOnEveryPress?: boolean;
  /** 스텝마다 난수를 한 번 더 쓴다 (호출 순서 어긋남) */
  extraRngPerStep?: boolean;
  /** 같은 dt를 절반씩 두 번 나눠 진행한다 (스텝 분할) */
  splitTick?: boolean;
  /** 보조 작업대 노드를 빼먹는다 (처리량 경로 미이식) */
  dropHelperNode?: boolean;
  /** 발견물을 수령하지 않는다 (도감·현금 경로 누락) */
  skipClaim?: boolean;
}

interface Outcome {
  cash: number;
  scrap: number;
  parts: number;
  cumScrap: number;
  totalMachines: number;
  maxGrade: number;
  codexIds: string[];
  findCount: number;
  finds: string[];
}

/** 골든이 보는 값 전부가 일치하는가 — golden.test.ts의 최종 대조와 같은 집합. */
function matchesGolden(o: Outcome): boolean {
  const f = scenario.final;
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-9, 1e-9);
  return (
    close(o.cash, f.cash) &&
    close(o.scrap, f.scrap) &&
    close(o.parts, f.parts) &&
    close(o.cumScrap, f.cumScrap) &&
    o.totalMachines === f.totalMachines &&
    o.maxGrade === f.maxGrade &&
    o.findCount === f.findCount &&
    JSON.stringify(o.codexIds) === JSON.stringify(f.codexIds)
  );
}

describe("뮤테이션 — 망가뜨리면 골든이 반드시 실패한다", () => {
  it("기준: 손대지 않은 엔진은 골든과 일치한다", () => {
    // 이게 실패하면 아래 주장들은 전부 무의미하다 — 먼저 확인한다.
    expect(matchesGolden(runScenario())).toBe(true);
  });

  const cases: { name: string; mutate: Mutation; why: string }[] = [
    {
      name: "매대 재고를 무시하고 누를 때마다 상태를 굴린다",
      mutate: { rollOnEveryPress: true },
      why: "실패한 매입도 난수를 소비해 이후 발견물 난수가 전부 밀린다 — 실제로 있었던 결함",
    },
    {
      name: "스텝마다 난수를 한 번 더 쓴다",
      mutate: { extraRngPerStep: true },
      why: "수식이 전부 맞아도 호출 횟수가 다르면 같은 시드에서 다른 세션이 된다",
    },
    {
      name: "같은 dt를 절반씩 두 번 나눠 진행한다",
      mutate: { splitTick: true },
      why: "발견 판정이 걸리는 프레임이 달라져 난수 소비가 어긋난다 — 총 시간이 같아도 결과는 다르다",
    },
    {
      name: "보조 작업대 노드를 빼먹는다",
      mutate: { dropHelperNode: true },
      why: "노드를 스텁으로 두면 helper 경로가 영영 실행되지 않는다 — 이 레포가 실제로 그랬다",
    },
    {
      name: "발견물을 수령하지 않는다",
      mutate: { skipClaim: true },
      why: "도감 패시브와 발견 보상 현금이 통째로 빠진다",
    },
  ];

  it.each(cases)("$name → 골든 실패", ({ mutate, why }) => {
    expect(matchesGolden(runScenario(mutate)), `이 결함을 골든이 못 잡는다: ${why}`).toBe(false);
  });
});

/**
 * 구매 전이 뮤테이션 — **골든이 그 경로를 정말 보고 있는가.**
 *
 * 비용 수식만 대조하던 때는 `buyTool(false)`가 엉뚱한 축을 올려도 246건이 통과했다
 * (적대적 리뷰 R7-20). 구매 명령열 골든을 붙였으니, 그 경로를 망가뜨리면 실패해야 한다.
 */
describe("뮤테이션 — 구매 전이를 망가뜨리면 골든이 실패한다", () => {
  const steps = fixtures.purchases;

  /** 픽스처의 한 단계와 지금 상태가 같은가 — 골든 테스트가 보는 것과 같은 집합. */
  function matches(w: Workshop, want: (typeof steps)[number]): boolean {
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-9, 1e-9);
    return (
      close(w.parts, want.parts) &&
      close(w.copper, want.copper) &&
      w.smashTier === want.smashTier &&
      w.stripTier === want.stripTier &&
      w.d.opEquipped === want.opEquipped &&
      close(w.stripDps, want.stripDps)
    );
  }

  /** 공구 구매까지 명령열을 그대로 밟는다 — 뮤테이션은 그 안에서 일어난다. */
  function runToTools(mutateAxis: boolean): { w: Workshop; ok: boolean } {
    const w = new Workshop(balance, newGame(balance));
    w.earnScrap(1e9);
    w.earnParts(1e9);
    w.earnSpecial(1e6, 1e6, 1e6);
    w.earnCash(1e9);

    let i = 1; // start는 건너뛴다
    for (const n of balance.skill.nodes) {
      w.buyNode(n.id);
      i++;
    }
    const first = balance.skill.nodes[0];
    for (let k = w.nodeLv(first.id); k < first.max + 2; k++) {
      w.buyNode(first.id);
      i++;
    }

    let ok = true;
    for (let k = 0; k < balance.tool.tierCount + 1; k++) {
      w.buyTool(true);
      ok = ok && matches(w, steps[i++]);
      // **뮤테이션**: 뜯기를 사야 하는데 부수기를 산다 (축이 바뀐 흔한 실수)
      w.buyTool(mutateAxis ? true : false);
      ok = ok && matches(w, steps[i++]);
    }
    return { w, ok };
  }

  it("기준: 손대지 않으면 골든과 일치한다", () => {
    expect(runToTools(false).ok).toBe(true);
  });

  it("공구 축을 바꾸면 골든이 실패한다", () => {
    expect(runToTools(true).ok, "buyTool의 축이 바뀌었는데 골든이 통과했다").toBe(false);
  });

  it("환생이 지워야 할 것을 남기면 골든이 실패한다", () => {
    const last = steps[steps.length - 1];
    const w = new Workshop(balance, newGame(balance));
    w.earnScrap(1e9);
    // **뮤테이션**: 노드를 남긴다 (원작은 환생에서 스킬트리를 비운다)
    const n = balance.skill.nodes[0];
    w.buyNode(n.id);
    w.d.certs = last.certs;
    // 노드를 지우지 않은 상태 — 골든의 마지막 단계와 다르다
    expect(
      w.d.nodeIds.map((id, i2) => ({ id, lv: w.d.nodeLevels[i2] })),
    ).not.toEqual(last.nodes);
  });
});
