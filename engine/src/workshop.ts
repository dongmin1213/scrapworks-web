import type { Balance } from "./balance";

/**
 * 공방 — 영구 상태와 스탯 집계. 원본 `Scrap.Workshop`의 이식.
 *
 * 원본은 스킬 노드·작업자·인증·도감이 전부 붙어 있는데, **웹판 1단계는 그 전부를 옮기지
 * 않는다.** 이식은 되는 것부터 정확하게 하고, 없는 것은 없다고 적는다 —
 * 반쯤 옮긴 수식이 "그럴듯하게 다른 값"을 내는 것이 가장 나쁘다.
 *
 * 지금 이식된 것: 현금·자원 원장, 등급 해금, 기본 DPS, 도구 티어.
 * 아직 아닌 것(전부 0으로 취급하고 주석에 남긴다): 스킬 노드(NodeSum), 작업자(Op),
 * 인증(CertMult), 도감 보너스(CodexBonus), 보조 작업대(HelperUnlocked).
 */
export interface SaveData {
  cash: number;
  scrap: number;
  parts: number;
  copper: number;
  boards: number;
  cores: number;
  /** 지금까지 번 현금 누계 — 등급 해금 판정의 기준 (보유 현금이 아니다) */
  lifetimeCash: number;
  maxGrade: number;
  smashTier: number;
  stripTier: number;
  totalMachines: number;
  /** 도감에 등록된 발견물 id */
  codex: string[];
}

export function newGame(balance: Balance): SaveData {
  const start = balance.data.start as { cash?: number } | undefined;
  return {
    cash: start?.cash ?? 0,
    scrap: 0,
    parts: 0,
    copper: 0,
    boards: 0,
    cores: 0,
    lifetimeCash: 0,
    maxGrade: 1,
    smashTier: 1,
    stripTier: 1,
    totalMachines: 0,
    codex: [],
  };
}

export class Workshop {
  constructor(
    readonly balance: Balance,
    public d: SaveData,
  ) {}

  get cash() {
    return this.d.cash;
  }

  earnCash(v: number) {
    this.d.cash += v;
    this.d.lifetimeCash += v;
  }

  spendCash(v: number) {
    this.d.cash = Math.max(0, this.d.cash - v);
  }

  earnScrap(v: number) {
    this.d.scrap += v;
  }

  earnParts(v: number) {
    this.d.parts += v;
  }

  earnSpecial(copper: number, boards: number, cores: number) {
    this.d.copper += copper;
    this.d.boards += boards;
    this.d.cores += cores;
  }

  addCodex(id: string) {
    if (!this.d.codex.includes(id)) this.d.codex.push(id);
  }

  /**
   * 스킬 노드 합 — **아직 이식되지 않았다.** 원본은 노드 트리가 여기에 더해진다.
   * 0을 돌려주는 것이 "노드가 없는 상태"와 정확히 같으므로 수식은 그대로 성립한다.
   */
  nodeSum(_stat: string): number {
    return 0;
  }

  /** 도감 패시브 — 발견물을 모으면 붙는 영구 보너스. 아직 미이식(위 주석). */
  private codexBonus(_stat: string): number {
    return 0;
  }

  /** 인증 배수 — 아직 미이식. 1은 "인증 없음"과 같다. */
  private get certMult(): number {
    return 1;
  }

  private get tool() {
    return this.balance.data.tool as {
      smashDps: number;
      stripDps: number;
      tierMult: number;
    };
  }

  get smashDps(): number {
    return (
      (this.tool.smashDps + this.nodeSum("smashFlat")) *
      Math.pow(this.tool.tierMult, this.d.smashTier - 1) *
      (1 + this.nodeSum("smashPct") + this.codexBonus("smashPct")) *
      this.certMult
    );
  }

  get stripDps(): number {
    return (
      (this.tool.stripDps + this.nodeSum("stripFlat")) *
      Math.pow(this.tool.tierMult, this.d.stripTier - 1) *
      (1 + this.nodeSum("stripPct") + this.codexBonus("stripPct")) *
      this.certMult
    );
  }

  get scrapVal(): number {
    return (1 + this.nodeSum("scrapPct") + this.codexBonus("scrapPct")) * this.certMult;
  }

  get partsVal(): number {
    return (1 + this.nodeSum("partsPct") + this.codexBonus("partsPct")) * this.certMult;
  }

  get cashVal(): number {
    return (1 + this.nodeSum("cashPct") + this.codexBonus("cashPct")) * this.certMult;
  }

  get findBonus(): number {
    return this.nodeSum("findPct") + this.codexBonus("findPct");
  }

  get helperUnlocked(): boolean {
    return this.nodeSum("helper") > 0;
  }
}
