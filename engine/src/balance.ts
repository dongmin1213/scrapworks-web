/**
 * 밸런스 — **모든 게임 수치의 유일한 출처.**
 *
 * 원본(Unity `Scrap.Balance`)과 **같은 `balance.json`을 읽는다.** 수치를 여기 옮겨 적지 않는다 —
 * 옮겨 적는 순간 원본과 갈라지고, 갈라진 것을 아무도 모른다.
 * 원본 레포의 `unity/Assets/Resources/balance.json`을 그대로 복사해 쓰며,
 * 골든 테스트가 두 구현의 계산 결과를 대조한다.
 */

export interface LineCfg {
  queueSlots: number;
  conveyorSeconds: number;
  settleSeconds: number;
  saveIntervalSec: number;
}

export interface MachineCfg {
  gradeCap: number;
  /** 등급 n 매입가 = buyBase × buyGrowth^(n-1) */
  buyBase: number;
  buyGrowth: number;
  /** 등급 n 내구도 (해체 소요 = 내구도 / 처리속도) */
  durBase: number;
  durGrowth: number;
  /** 등급 n 회수 기대액 (고철+부품 합산) */
  yieldBase: number;
  yieldGrowth: number;
  /** 회수액 중 부품 몫 (나머지가 고철) */
  partsShare: number;
  /** 다음 등급 해금: 누적 수입 ≥ 매입가 × 이 값 */
  unlockMargin: number;
}

export interface AxisCfg {
  smashScrapMult: number;
  stripScrapMult: number;
  smashPartsMult: number;
  stripPartsMult: number;
  smashFindMult: number;
  stripFindMult: number;
}

export interface ConditionDef {
  id: string;
  weight: number;
  priceMult: number;
  durMult: number;
  scrapMult: number;
  partsMult: number;
  findMult: number;
  /** 미개봉 — 해체가 시작돼야 상태가 드러난다 */
  hidden?: boolean;
}

export interface FindItem {
  id: string;
  weight: number;
  minGrade: number;
  cashMult: number;
  /** 도감 등록 시 붙는 영구 패시브 종류 (cashPct·findPct 등) */
  passive?: string;
  value?: number;
}

export interface FindCfg {
  baseChance: number;
  gradeBonus: number;
  items: FindItem[];
}

export interface SpecialCfg {
  copperBase: number;
  boardsBase: number;
  coresBase: number;
  /** 등급 스케일 배수 — 원본은 `qtyGrowth^(grade-1)`이다 (지수가 아니라 밑) */
  qtyGrowth: number;
}

export interface FeelCfg {
  dropsPerMachine: number;
  [key: string]: unknown;
}

export interface BalanceData {
  line: LineCfg;
  machine: MachineCfg;
  axis: AxisCfg;
  special: SpecialCfg;
  find: FindCfg;
  conditions: ConditionDef[];
  feel: FeelCfg;
  tool: Record<string, unknown>;
  skill: Record<string, unknown>;
  shop: Record<string, unknown>;
  cert: Record<string, unknown>;
  night: Record<string, unknown>;
  start: Record<string, unknown>;
}

export class Balance {
  constructor(readonly data: BalanceData) {}

  get line() {
    return this.data.line;
  }
  get machine() {
    return this.data.machine;
  }
  get axis() {
    return this.data.axis;
  }
  get find() {
    return this.data.find;
  }
  get special() {
    return this.data.special;
  }
  get feel() {
    return this.data.feel;
  }
  get conditions() {
    return this.data.conditions;
  }

  /** 등급 n 매입가 — 원본 `Balance.BuyPrice`. */
  buyPrice(grade: number): number {
    return this.machine.buyBase * Math.pow(this.machine.buyGrowth, grade - 1);
  }

  /** 등급 n 내구도 — 원본 `Balance.Durability`. */
  durability(grade: number): number {
    return this.machine.durBase * Math.pow(this.machine.durGrowth, grade - 1);
  }

  /** 등급 n 회수 기대액(고철+부품) — 원본 `Balance.YieldTotal`. */
  yieldTotal(grade: number): number {
    return this.machine.yieldBase * Math.pow(this.machine.yieldGrowth, grade - 1);
  }

  /**
   * 특수 자원 수량 — 원본 `Balance.SpecialQty`.
   * `baseQty × qtyGrowth^(grade-1)` — 등급을 밑으로 쓰지 않는다(처음에 그렇게 잘못 옮겼다).
   */
  specialQty(base: number, grade: number): number {
    return base * Math.pow(this.special.qtyGrowth, grade - 1);
  }

  condition(id: string): ConditionDef {
    return this.conditions.find((c) => c.id === id) ?? this.conditions[0];
  }

  findItemOf(id: string): FindItem | undefined {
    return this.find.items.find((f) => f.id === id);
  }
}
