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

/** 공구 티어별 특수 자원 요구량 — 인덱스는 **현재 티어**(0-base로 다음 단계를 가리킨다). */
export interface SpecialCost {
  copper: number;
  boards: number;
  cores: number;
}

export interface ToolCfg {
  smashDps: number;
  stripDps: number;
  tierMult: number;
  tierCount: number;
  costBase: number;
  costGrowth: number;
  smashSpecial: SpecialCost[];
  stripSpecial: SpecialCost[];
}

export interface NodeDef {
  id: string;
  /** 이 노드가 올리는 스탯 키 — `smashFlat`·`helper`·`queueAdd` 등 */
  stat: string;
  per: number;
  max: number;
  baseCost: number;
}

export interface SkillCfg {
  costGrowth: number;
  nodes: NodeDef[];
}

export interface OperatorDef {
  id: string;
  smashPct: number;
  stripPct: number;
  scrapValPct: number;
  partsValPct: number;
  cashValPct: number;
  allValPct: number;
  findPct: number;
}

export interface ShopCfg {
  operatorCostBase: number;
  operatorCostGrowth: number;
  operators: OperatorDef[];
}

export interface CertCfg {
  scrapDivisor: number;
  multPerCert: number;
}

export interface NightCfg {
  capHours: number;
  /** 야간 산출 = 활성 시 처리율 × 이 비율 */
  rateOfActive: number;
}

export interface StartCfg {
  cash: number;
  scrap: number;
  parts: number;
  smashTier: number;
  stripTier: number;
  maxGrade: number;
}

export interface BalanceData {
  line: LineCfg;
  machine: MachineCfg;
  axis: AxisCfg;
  special: SpecialCfg;
  find: FindCfg;
  conditions: ConditionDef[];
  feel: FeelCfg;
  tool: ToolCfg;
  skill: SkillCfg;
  shop: ShopCfg;
  cert: CertCfg;
  night: NightCfg;
  start: StartCfg;
}

export class Balance {
  /**
   * 원작에서 **float(32비트)로 선언된 값들**을 그 정밀도로 내려 둔다.
   *
   * `LineCfg.conveyorSeconds`·`settleSeconds`와 `FeelCfg`의 시간 값은 C#에서 `float`이다.
   * JSON에서 읽은 1.6은 배정밀도 1.6이지만 원작이 실제로 쓰는 값은 float32의 1.6(≈1.60000002…)이다.
   * 그 차이를 남겨 두면 컨베이어가 1.0에 닿는 프레임이 어긋나고, 그 한 칸이 매입 타이밍을
   * 바꾸고, 매입 타이밍이 난수 소비를 바꿔 세션 전체가 갈라진다 (적대적 리뷰 R5).
   *
   * 쓰는 자리마다 fround를 뿌리지 않고 **읽는 지점에서 한 번** 맞춘다 — 뿌리면 언젠가 빠뜨린다.
   */
  private readonly lineF32: LineCfg;

  constructor(readonly data: BalanceData) {
    this.lineF32 = {
      ...data.line,
      conveyorSeconds: Math.fround(data.line.conveyorSeconds),
      settleSeconds: Math.fround(data.line.settleSeconds),
    };
  }

  get line() {
    return this.lineF32;
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
  get tool() {
    return this.data.tool;
  }
  get skill() {
    return this.data.skill;
  }
  get shop() {
    return this.data.shop;
  }
  get cert() {
    return this.data.cert;
  }
  get night() {
    return this.data.night;
  }
  get start() {
    return this.data.start;
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

  /** 스킬 노드 다음 레벨 비용 — 원본 `Balance.NodeCost`. */
  nodeCost(n: NodeDef, level: number): number {
    return n.baseCost * Math.pow(this.skill.costGrowth, level);
  }

  /** 작업자 rank 구입비 — 원본 `Balance.OperatorCost`. 지수가 `rank - 2`다(2단이 첫 구매). */
  operatorCost(rank: number): number {
    return this.shop.operatorCostBase * Math.pow(this.shop.operatorCostGrowth, rank - 2);
  }

  /** 공구 tier 구입비 — 원본 `Balance.ToolCost`. */
  toolCost(tier: number): number {
    return this.tool.costBase * Math.pow(this.tool.costGrowth, tier - 1);
  }

  /**
   * 인증 수 — **상한이 규칙이다.** 원본 주석: 상한이 없으면 누적 고철이 커질 때
   * `(int)` 캐스팅에서 음수 인증이 나와 배수가 뒤집힌다(원본 실측).
   */
  static readonly CERT_CAP = 10000;

  certsFrom(cumScrap: number): number {
    const v = Math.sqrt(Math.max(0, cumScrap) / this.cert.scrapDivisor);
    return Math.floor(Math.min(v, Balance.CERT_CAP));
  }

  /**
   * 인증 배수 — **선형 가산**. 지수(1.08^n)로 두면 환생을 반복할수록 배수가 폭주해
   * 벽이 영구히 사라진다(원본 시뮬 실측: 6시간에 인증 5천만, 곡선 붕괴).
   */
  certMult(certs: number): number {
    return 1 + this.cert.multPerCert * certs;
  }

  condition(id: string): ConditionDef {
    return this.conditions.find((c) => c.id === id) ?? this.conditions[0];
  }

  findItemOf(id: string): FindItem | undefined {
    return this.find.items.find((f) => f.id === id);
  }
}
