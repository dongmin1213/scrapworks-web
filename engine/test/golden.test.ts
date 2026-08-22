import { describe, expect, it } from "vitest";
import fixtures from "../../golden/fixtures/core.json";
import balanceJson from "../content/balance.json";
import { Balance, type BalanceData } from "../src/balance";
import { DotNetRandom } from "../src/rng";

/**
 * 골든 대조 — **원본과 값이 같은가.**
 *
 * 픽스처는 `golden/csharp/DumpFixtures.csx`가 만든다. 그 스크립트는 원본과 **같은
 * balance.json**을 읽고 **.NET System.Random 그 자체**를 돌린다. 그래서 여기서 값이
 * 갈라지면 이식이 틀린 것이다 — 추측이 아니라 대조다.
 *
 * 소울 던전에서 원작 Dart를 직접 호출해 대조한 것과 같은 원칙이다:
 * **이식의 정확성은 눈이 아니라 기계가 확인한다.**
 */

const balance = new Balance(balanceJson as unknown as BalanceData);

/** 부동소수 비교 — 두 런타임의 double 연산은 IEEE754로 같지만 직렬화 왕복 오차만 허용한다. */
function expectClose(actual: number, expected: number, label: string) {
  const tolerance = Math.max(Math.abs(expected) * 1e-12, 1e-12);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    tolerance,
  );
}

describe("난수 — .NET System.Random을 정확히 재현한다", () => {
  it.each(fixtures.rngCases)("시드 $seed", ({ seed, doubles, ints }) => {
    const rng = new DotNetRandom(seed);
    for (let i = 0; i < doubles.length; i++) {
      expectClose(rng.nextDouble(), doubles[i], `시드 ${seed} nextDouble[${i}]`);
    }
    for (let i = 0; i < ints.length; i++) {
      expect(rng.next(100), `시드 ${seed} next(100)[${i}]`).toBe(ints[i]);
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
      expectClose(
        balance.specialQty(balance.special.copperBase, grade),
        copper,
        `등급 ${grade} 구리`,
      );
      expectClose(
        balance.specialQty(balance.special.boardsBase, grade),
        boards,
        `등급 ${grade} 기판`,
      );
      expectClose(balance.specialQty(balance.special.coresBase, grade), cores, `등급 ${grade} 코어`);
    },
  );
});

describe("매물 상태 굴림 — 가중 선택의 순서까지 같다", () => {
  it.each(fixtures.conditionRolls)("시드 $seed", ({ seed, rolled }) => {
    const rng = new DotNetRandom(seed);
    const total = balance.conditions.reduce((sum, c) => sum + c.weight, 0);

    const actual: string[] = [];
    for (let i = 0; i < rolled.length; i++) {
      let r = rng.next(total);
      let picked = balance.conditions[0].id;
      for (const c of balance.conditions) {
        r -= c.weight;
        if (r < 0) {
          picked = c.id;
          break;
        }
      }
      actual.push(picked);
    }

    expect(actual).toEqual(rolled);
  });
});

describe("해체 정산 — 축 비율·상태 배수가 회수액을 만든다", () => {
  it.each(fixtures.settlements)(
    "등급 $grade · $condition · 뜯기비율 $stripFrac",
    ({ grade, condition, stripFrac, scrapVal, partsVal }) => {
      const cond = balance.condition(condition);
      const axis = balance.axis;
      const scrapMult =
        axis.smashScrapMult + (axis.stripScrapMult - axis.smashScrapMult) * stripFrac;
      const partsMult =
        axis.smashPartsMult + (axis.stripPartsMult - axis.smashPartsMult) * stripFrac;
      const total = balance.yieldTotal(grade);

      expectClose(
        total * (1 - balance.machine.partsShare) * scrapMult * cond.scrapMult,
        scrapVal,
        "고철",
      );
      expectClose(total * balance.machine.partsShare * partsMult * cond.partsMult, partsVal, "부품");
    },
  );
});

describe("발견 확률 — 부수면 망가진다(축이 확률을 가른다)", () => {
  it.each(fixtures.findChances)(
    "등급 $grade · $condition · 뜯기비율 $stripFrac",
    ({ grade, condition, stripFrac, chance }) => {
      const cond = balance.condition(condition);
      const axis = balance.axis;
      const axisMult = axis.smashFindMult + (axis.stripFindMult - axis.smashFindMult) * stripFrac;
      const actual =
        (balance.find.baseChance + balance.find.gradeBonus * (grade - 1)) * axisMult * cond.findMult;
      expectClose(actual, chance, "발견 확률");
    },
  );

  it("뜯기가 부수기보다 발견 확률이 높다 — 이 게임의 코어 규칙", () => {
    const smash = fixtures.findChances.find((f) => f.stripFrac === 0 && f.grade === 5)!;
    const strip = fixtures.findChances.find((f) => f.stripFrac === 1 && f.grade === 5)!;
    expect(strip.chance).toBeGreaterThan(smash.chance);
  });
});
