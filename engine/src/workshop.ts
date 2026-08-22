import { Balance } from "./balance";
import type { NodeDef, OperatorDef } from "./balance";

/**
 * 공방 — 영구 상태와 스탯 집계. 원본 `Scrap.Workshop`의 1:1 이식.
 *
 * **처음엔 노드·작업자·인증·도감을 전부 0/1 스텁으로 뒀다.** "0은 없는 상태와 같으니
 * 수식은 성립한다"고 적었지만 그건 틀렸다 — 원본에서 보조 작업대(`helper`)와 대기열 확장
 * (`queueAdd`)이 **노드로만 열리므로**, 스텁이면 그 경로가 영영 실행되지 않고
 * 골든이 덮을 수 없는 사각지대가 된다. 게임 중반 이후 전부가 그 사각지대였다.
 * 그래서 지금은 원작 전체를 옮긴다.
 *
 * 저장 규약: `SaveData`는 원본 `Scrap.SaveData`와 **필드 이름까지 같다.** 이름이 갈라지면
 * 원본 세이브를 읽을 수 없고, 골든 하네스가 만든 상태를 그대로 밀어 넣을 수도 없다.
 */

/** 저장 데이터 — 원본 `Scrap.SaveData`와 1:1. */
export interface SaveData {
  version: number;

  // 재화 — 현금은 매입 자금, 고철은 성장 자금
  cash: number;
  scrap: number;
  parts: number;
  copper: number;
  boards: number;
  cores: number;
  /** 이번 작업장 누적 고철 — 인증 산정 기준 (환생 시 리셋) */
  cumScrap: number;
  /** 전체 누적 현금 — **등급 해금 판정의 기준** (보유 현금이 아니다) */
  lifetimeCash: number;

  // 진행
  maxGrade: number;
  smashTier: number;
  stripTier: number;
  /** 작업자 사다리 보유 최고 단 (순차 구매) */
  opRank: number;
  /** 착용 중 작업자 단 (1-base) */
  opEquipped: number;

  /** 스킬 노드 레벨 — 원본이 JsonUtility 제약으로 평행 리스트를 쓴다. 그 형식을 유지한다. */
  nodeIds: string[];
  nodeLevels: number[];

  /** 도감 — 중복은 등록하지 않는다 (패시브 1회) */
  codexIds: string[];
  findCount: number;

  // 환생
  certs: number;
  rebirthCount: number;

  // 통계
  totalMachines: number;

  // 설정
  sfxOn: boolean;

  /** 마지막 실시각(UTC ms) — 야간 작업조·시계 되돌림 감지의 기준. */
  lastUtcMs: number;
}

/** 새 게임 — **balance.start가 유일한 출처다.** 여기에 숫자를 적지 않는다. */
export function newGame(balance: Balance): SaveData {
  const s = balance.start;
  return {
    version: SAVE_VERSION,
    cash: s.cash,
    scrap: s.scrap,
    parts: s.parts,
    copper: 0,
    boards: 0,
    cores: 0,
    cumScrap: 0,
    lifetimeCash: 0,
    maxGrade: s.maxGrade,
    smashTier: s.smashTier,
    stripTier: s.stripTier,
    opRank: 1,
    opEquipped: 1,
    nodeIds: [],
    nodeLevels: [],
    codexIds: [],
    findCount: 0,
    certs: 0,
    rebirthCount: 0,
    totalMachines: 0,
    sfxOn: true,
    lastUtcMs: 0,
  };
}

/** 세이브 스키마 버전 — 필드가 늘거나 의미가 바뀌면 올리고 마이그레이션을 붙인다. */
export const SAVE_VERSION = 3;

/**
 * 저장된 값을 **필드 단위로 검증해** 온전한 SaveData를 만든다.
 *
 * 이전에는 `{ ...newGame(), ...parsed }`로 얹기만 했다. 그러면 `{"codexIds": null}` 같은
 * **파싱은 되지만 망가진** 세이브가 기본값을 덮어써 첫 렌더에서 터진다 — 유저는 흰 화면을
 * 보고 되돌릴 방법이 없다. JSON.parse가 성공했다는 것은 **아무것도 보장하지 않는다.**
 *
 * 규칙: 이상한 필드는 **그 필드만** 기본값으로 되돌리고 게임은 계속된다.
 * 반환의 `intact`가 false면 호출부가 "일부 복구했다"고 알릴 수 있다.
 */
export function sanitizeSave(balance: Balance, raw: unknown): { d: SaveData; intact: boolean } {
  const base = newGame(balance);
  if (typeof raw !== "object" || raw === null) return { d: base, intact: false };
  const p = raw as Record<string, unknown>;
  let intact = true;

  const n = (key: keyof SaveData, min = 0): number => {
    const v = p[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= min) return v;
    if (v !== undefined) intact = false;
    return base[key] as number;
  };
  const i = (key: keyof SaveData, min: number, max: number): number => {
    const v = p[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) return v;
    if (v !== undefined) intact = false;
    return base[key] as number;
  };
  const strs = (key: keyof SaveData): string[] => {
    const v = p[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
    if (v !== undefined) intact = false;
    return base[key] as string[];
  };

  const d: SaveData = {
    version: SAVE_VERSION,
    cash: n("cash"),
    scrap: n("scrap"),
    parts: n("parts"),
    copper: n("copper"),
    boards: n("boards"),
    cores: n("cores"),
    cumScrap: n("cumScrap"),
    lifetimeCash: n("lifetimeCash"),
    maxGrade: i("maxGrade", 1, balance.machine.gradeCap),
    smashTier: i("smashTier", 1, balance.tool.tierCount),
    stripTier: i("stripTier", 1, balance.tool.tierCount),
    opRank: i("opRank", 1, balance.shop.operators.length),
    opEquipped: i("opEquipped", 1, balance.shop.operators.length),
    nodeIds: strs("nodeIds"),
    nodeLevels: [],
    codexIds: strs("codexIds").filter((id) => balance.findItemOf(id) !== undefined),
    findCount: i("findCount", 0, Number.MAX_SAFE_INTEGER),
    certs: i("certs", 0, Balance.CERT_CAP),
    rebirthCount: i("rebirthCount", 0, Number.MAX_SAFE_INTEGER),
    totalMachines: i("totalMachines", 0, Number.MAX_SAFE_INTEGER),
    sfxOn: p.sfxOn !== false,
    lastUtcMs: n("lastUtcMs"),
  };

  // 노드는 **평행 리스트**라 길이가 어긋나면 레벨이 엉뚱한 노드에 붙는다.
  // 존재하지 않는 id와 상한을 넘는 레벨도 여기서 떨어낸다 — 조작된 세이브의 주 통로다.
  const rawLevels = Array.isArray(p.nodeLevels) ? (p.nodeLevels as unknown[]) : [];
  const keptIds: string[] = [];
  const keptLevels: number[] = [];
  d.nodeIds.forEach((id, idx) => {
    const def = balance.skill.nodes.find((x) => x.id === id);
    const lv = rawLevels[idx];
    if (!def || typeof lv !== "number" || !Number.isInteger(lv) || lv < 1) {
      intact = false;
      return;
    }
    keptIds.push(id);
    keptLevels.push(Math.min(lv, def.max));
    if (lv > def.max) intact = false;
  });
  d.nodeIds = keptIds;
  d.nodeLevels = keptLevels;

  // opEquipped는 보유 단수를 넘을 수 없다 — 넘으면 안 산 작업자의 보너스가 붙는다
  if (d.opEquipped > d.opRank) {
    d.opEquipped = d.opRank;
    intact = false;
  }

  if (p.version !== undefined && p.version !== SAVE_VERSION) intact = false;
  return { d, intact };
}

export class Workshop {
  constructor(
    readonly balance: Balance,
    public d: SaveData,
  ) {}

  // ---- 재화 ----

  get cash() {
    return this.d.cash;
  }
  get scrap() {
    return this.d.scrap;
  }
  get parts() {
    return this.d.parts;
  }
  get copper() {
    return this.d.copper;
  }
  get boards() {
    return this.d.boards;
  }
  get cores() {
    return this.d.cores;
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
    this.d.cumScrap += v; // 인증 산정 기준 — 쓰더라도 누계는 줄지 않는다
  }

  earnParts(v: number) {
    this.d.parts += v;
  }

  earnSpecial(copper: number, boards: number, cores: number) {
    this.d.copper += copper;
    this.d.boards += boards;
    this.d.cores += cores;
  }

  // ---- 도감 (발견물) ----

  hasCodex(id: string): boolean {
    return this.d.codexIds.includes(id);
  }

  get codexCount(): number {
    return this.d.codexIds.length;
  }

  /** 같은 발견물을 또 먹어도 **패시브는 1회만** (수집 가치 보존). 획득 횟수는 따로 센다. */
  addCodex(id: string) {
    if (!this.d.codexIds.includes(id)) this.d.codexIds.push(id);
    this.d.findCount++;
  }

  codexBonus(stat: string): number {
    let v = 0;
    for (const id of this.d.codexIds) {
      const f = this.balance.findItemOf(id);
      if (f && f.passive === stat) v += f.value ?? 0;
    }
    return v;
  }

  // ---- 스킬 노드 ----

  nodeLv(id: string): number {
    const i = this.d.nodeIds.indexOf(id);
    return i < 0 ? 0 : this.d.nodeLevels[i];
  }

  nodeSum(stat: string): number {
    let v = 0;
    for (const n of this.balance.skill.nodes) {
      if (n.stat === stat) v += n.per * this.nodeLv(n.id);
    }
    return v;
  }

  node(id: string): NodeDef | undefined {
    return this.balance.skill.nodes.find((n) => n.id === id);
  }

  nodeCost(id: string): number {
    const n = this.node(id);
    return n ? this.balance.nodeCost(n, this.nodeLv(id)) : Number.POSITIVE_INFINITY;
  }

  nodeMaxed(id: string): boolean {
    const n = this.node(id);
    return !n || this.nodeLv(id) >= n.max;
  }

  canBuyNode(id: string): boolean {
    return !this.nodeMaxed(id) && this.d.scrap >= this.nodeCost(id);
  }

  buyNode(id: string): boolean {
    if (!this.canBuyNode(id)) return false;
    this.d.scrap -= this.nodeCost(id);
    const i = this.d.nodeIds.indexOf(id);
    if (i < 0) {
      this.d.nodeIds.push(id);
      this.d.nodeLevels.push(1);
    } else {
      this.d.nodeLevels[i]++;
    }
    return true;
  }

  // ---- 작업자 ----

  get op(): OperatorDef {
    const ops = this.balance.shop.operators;
    return ops[clamp(this.d.opEquipped, 1, ops.length) - 1];
  }

  get ladderDone(): boolean {
    return this.d.opRank >= this.balance.shop.operators.length;
  }

  get nextOpCost(): number {
    return this.balance.operatorCost(this.d.opRank + 1);
  }

  get canBuyOp(): boolean {
    return !this.ladderDone && this.d.parts >= this.nextOpCost;
  }

  buyOp(): boolean {
    if (!this.canBuyOp) return false;
    this.d.parts -= this.nextOpCost;
    this.d.opRank++;
    this.d.opEquipped = this.d.opRank;
    return true;
  }

  equip(rank: number) {
    this.d.opEquipped = clamp(rank, 1, this.d.opRank);
  }

  // ---- 공구 ----

  get smashTier() {
    return this.d.smashTier;
  }
  get stripTier() {
    return this.d.stripTier;
  }

  toolMaxed(smash: boolean): boolean {
    return (smash ? this.d.smashTier : this.d.stripTier) >= this.balance.tool.tierCount;
  }

  toolCost(smash: boolean): number {
    return this.balance.toolCost((smash ? this.d.smashTier : this.d.stripTier) + 1);
  }

  /** 다음 티어의 특수 자원 요구량 — 인덱스가 **현재 티어**다(원본과 같은 0-base 오프셋). */
  toolSpecial(smash: boolean) {
    const t = this.balance.tool;
    return smash ? t.smashSpecial[this.d.smashTier] : t.stripSpecial[this.d.stripTier];
  }

  canBuyTool(smash: boolean): boolean {
    if (this.toolMaxed(smash)) return false;
    const sp = this.toolSpecial(smash);
    return (
      this.d.parts >= this.toolCost(smash) &&
      this.d.copper >= sp.copper &&
      this.d.boards >= sp.boards &&
      this.d.cores >= sp.cores
    );
  }

  buyTool(smash: boolean): boolean {
    if (!this.canBuyTool(smash)) return false;
    const sp = this.toolSpecial(smash);
    this.d.parts -= this.toolCost(smash);
    this.d.copper -= sp.copper;
    this.d.boards -= sp.boards;
    this.d.cores -= sp.cores;
    if (smash) this.d.smashTier++;
    else this.d.stripTier++;
    return true;
  }

  // ---- 스탯 집계 ----

  get certMult(): number {
    return this.balance.certMult(this.d.certs);
  }

  get smashDps(): number {
    const t = this.balance.tool;
    return (
      (t.smashDps + this.nodeSum("smashFlat")) *
      Math.pow(t.tierMult, this.d.smashTier - 1) *
      (1 + this.nodeSum("smashPct") + this.op.smashPct + this.codexBonus("smashPct")) *
      this.certMult
    );
  }

  get stripDps(): number {
    const t = this.balance.tool;
    return (
      (t.stripDps + this.nodeSum("stripFlat")) *
      Math.pow(t.tierMult, this.d.stripTier - 1) *
      (1 + this.nodeSum("stripPct") + this.op.stripPct + this.codexBonus("stripPct")) *
      this.certMult
    );
  }

  get scrapVal(): number {
    return (
      (1 +
        this.nodeSum("scrapPct") +
        this.op.scrapValPct +
        this.op.allValPct +
        this.codexBonus("scrapPct")) *
      this.certMult
    );
  }

  get partsVal(): number {
    return (
      (1 +
        this.nodeSum("partsPct") +
        this.op.partsValPct +
        this.op.allValPct +
        this.codexBonus("partsPct")) *
      this.certMult
    );
  }

  get cashVal(): number {
    return (
      (1 +
        this.nodeSum("cashPct") +
        this.op.cashValPct +
        this.op.allValPct +
        this.codexBonus("cashPct")) *
      this.certMult
    );
  }

  /** 발견 확률 가산 (노드 + 작업자 + 도감). */
  get findBonus(): number {
    return this.nodeSum("findPct") + this.op.findPct + this.codexBonus("findPct");
  }

  get autoBuyUnlocked(): boolean {
    return this.nodeSum("autoBuy") > 0;
  }

  get helperUnlocked(): boolean {
    return this.nodeSum("helper") > 0;
  }

  // ---- 야간 작업조 ----

  /**
   * 활성 플레이 시 초당 기대 수입 — 야간 정산의 기준값.
   * 한 대 처리 시간(내구도/속도 + 반입·정산 텀) 대비 순이익으로 O(1) 추정한다.
   */
  activeCashPerSec(grade: number): number {
    const B = this.balance;
    const dur = B.durability(grade);
    const cycle = dur / Math.max(1, this.smashDps) + B.line.conveyorSeconds + B.line.settleSeconds;
    const gross =
      B.yieldTotal(grade) *
      ((1 - B.machine.partsShare) * B.axis.smashScrapMult +
        B.machine.partsShare * B.axis.smashPartsMult) *
      this.cashVal;
    return Math.max(0, (gross - B.buyPrice(grade)) / Math.max(0.1, cycle));
  }

  /**
   * 야간 작업조 정산 — 닫힌 수식(루프 없음). **시계가 되돌아가면 0이다.**
   * 반환: 지급된 현금. 0이면 알릴 것이 없다.
   */
  settleNight(awaySeconds: number): number {
    const B = this.balance;
    if (awaySeconds <= 60) return 0;
    const capped = Math.min(awaySeconds, B.night.capHours * 3600);
    const cash = this.activeCashPerSec(this.d.maxGrade) * B.night.rateOfActive * capped;
    if (cash <= 0) return 0;
    this.earnCash(cash);
    this.earnScrap(cash * 0.5); // 야간에도 고철이 쌓인다 (성장 통화가 멈추면 복귀 이유가 준다)
    return cash;
  }

  // ---- 인증 (환생) ----

  get certs(): number {
    return this.d.certs;
  }

  get pendingCerts(): number {
    return this.balance.certsFrom(this.d.cumScrap);
  }

  get canRebirth(): boolean {
    return this.pendingCerts >= 1;
  }

  /** 환생 — 유지: 공구·작업자·도감·인증 / 리셋: 현금·고철·부품·특수 자원·스킬트리·등급. */
  doRebirth(): boolean {
    if (!this.canRebirth) return false;
    this.d.certs += this.pendingCerts;
    this.d.rebirthCount++;
    this.d.scrap = 0;
    this.d.parts = 0;
    this.d.copper = 0;
    this.d.boards = 0;
    this.d.cores = 0;
    this.d.cumScrap = 0;
    this.d.cash = this.balance.start.cash;
    this.d.nodeIds = [];
    this.d.nodeLevels = [];
    this.d.maxGrade = this.balance.start.maxGrade;
    return true;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
