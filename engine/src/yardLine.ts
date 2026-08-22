import type { Balance } from "./balance";
import type { Rng } from "./rng";
import type { Workshop } from "./workshop";

/**
 * 작업 라인 — 매입·대기열·컨베이어·해체·발견물. 원본 `Scrap.YardLine`의 1:1 이식.
 *
 * 설계 근거(원본 design.md v2):
 *  - 압박은 타이머가 아니라 **대기열**에서 나온다 (칸이 차면 매입 불가)
 *  - **부수기는 빠르고 고철, 뜯기는 느리고 부품·발견물** — 두 축의 분리가 코어다
 *  - 작업장은 멈추지 않는다 (물건이 있으면 자동으로 계속 처리)
 *
 * **난수 호출 순서가 곧 규칙이다.** 매입 시 상태 1회, 해체 50% 지점에서 발견 판정 1~2회.
 * 순서가 바뀌면 같은 시드에서 다른 결과가 나오고 골든 대조가 무너진다.
 */

export type Axis = "smash" | "strip";

export interface Item {
  grade: number;
  conditionId: string;
  /** 미개봉이면 컨베이어 도착 전까지 false */
  revealed: boolean;
  maxHp: number;
  hp: number;
  smashDmg: number;
  totalDmg: number;
  dropAcc: number;
  /** 발견물 id — 해체 완료 시 확정 */
  pendingFind: string | null;
  findRolled: boolean;
}

export interface YardEvents {
  onDrop?: (item: Item, strip: boolean) => void;
  onItemDone?: (item: Item) => void;
  onFind?: (findId: string) => void;
  onBuy?: () => void;
}

export class YardLine {
  /** [0]이 작업 중인 물건 */
  readonly queue: Item[] = [];
  mode: Axis = "smash";
  /** 반입 이동 진행 (0~1) */
  conveyorT = 0;
  pendingPickup: string | null = null;
  pendingPickupCash = 0;

  private settleT = 0;

  constructor(
    private readonly balance: Balance,
    private readonly workshop: Workshop,
    private readonly rng: Rng,
    private readonly events: YardEvents = {},
  ) {}

  get current(): Item | null {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  get working(): boolean {
    return this.queue.length > 0 && this.conveyorT >= 1;
  }

  get queueSlots(): number {
    return this.balance.line.queueSlots + this.workshop.nodeSum("queueAdd");
  }

  get queueFull(): boolean {
    return this.queue.length >= this.queueSlots;
  }

  /** 보조 작업대가 잡고 있는 물건 (대기열 2번째). 축은 항상 부수기 — 판단은 유저 몫이다. */
  get helper(): Item | null {
    return this.workshop.helperUnlocked && this.queue.length > 1 ? this.queue[1] : null;
  }

  get maxBuyableGrade(): number {
    return Math.min(this.workshop.d.maxGrade, this.balance.machine.gradeCap);
  }

  // ---- 매입 ----

  /** 등급 n의 이번 매물 상태를 굴린다 (매입 시점 확정). 난수 1회. */
  rollCondition(): string {
    let total = 0;
    for (const c of this.balance.conditions) total += c.weight;
    let r = this.rng.next(total);
    for (const c of this.balance.conditions) {
      r -= c.weight;
      if (r < 0) return c.id;
    }
    return this.balance.conditions[0].id;
  }

  priceOf(grade: number, conditionId: string): number {
    return this.balance.buyPrice(grade) * this.balance.condition(conditionId).priceMult;
  }

  canBuy(grade: number, conditionId: string): boolean {
    return (
      !this.queueFull &&
      grade <= this.maxBuyableGrade &&
      this.workshop.cash >= this.priceOf(grade, conditionId)
    );
  }

  /** 매입 — 대기열에 넣는다. 칸이 없으면 실패 (손실 없음, 기회비용만). */
  buy(grade: number, conditionId: string): boolean {
    if (!this.canBuy(grade, conditionId)) return false;
    const cond = this.balance.condition(conditionId);
    this.workshop.spendCash(this.priceOf(grade, conditionId));

    const hp = this.balance.durability(grade) * cond.durMult;
    this.queue.push({
      grade,
      conditionId,
      revealed: !cond.hidden,
      maxHp: hp,
      hp,
      smashDmg: 0,
      totalDmg: 0,
      dropAcc: 0,
      pendingFind: null,
      findRolled: false,
    });
    if (this.queue.length === 1) this.conveyorT = 0; // 첫 물건이면 컨베이어 이동 시작
    this.events.onBuy?.();
    return true;
  }

  toggleMode() {
    this.mode = this.mode === "smash" ? "strip" : "smash";
  }

  setMode(a: Axis) {
    this.mode = a;
  }

  // ---- 진행 ----

  tick(dt: number): void {
    if (this.queue.length === 0) return;

    if (this.settleT > 0) {
      this.settleT -= dt;
      if (this.settleT > 0) return;
    }

    // 컨베이어 이동 — 도착해야 해체가 시작된다
    if (this.conveyorT < 1) {
      const speed =
        1 /
        Math.max(
          0.05,
          this.balance.line.conveyorSeconds / (1 + this.workshop.nodeSum("conveyorPct")),
        );
      this.conveyorT = Math.min(1, this.conveyorT + speed * dt);
      if (this.conveyorT >= 1 && this.current) this.current.revealed = true; // 도착 = 개봉
      return;
    }

    const it = this.current;
    if (!it) return;

    const strip = this.mode === "strip";
    const dps = strip ? this.workshop.stripDps : this.workshop.smashDps;
    const dmg = Math.min(it.hp, dps * dt);
    it.hp -= dmg;
    it.totalDmg += dmg;
    if (!strip) it.smashDmg += dmg;

    // 연출 드랍 (가치는 완료 시 수식이 전담 — 드랍은 화면을 채우는 역할)
    it.dropAcc += (this.balance.feel.dropsPerMachine * dmg) / it.maxHp;
    while (it.dropAcc >= 1) {
      it.dropAcc -= 1;
      this.events.onDrop?.(it, strip);
    }

    // 발견물은 해체 **중반**에 드러난다 — 끝까지 가야 아는 게 아니라 과정에서 두근거리게
    if (!it.findRolled && it.totalDmg >= it.maxHp * 0.5) {
      it.findRolled = true;
      it.pendingFind = this.rollFind(it);
      if (it.pendingFind) this.events.onFind?.(it.pendingFind);
    }

    if (it.hp <= 0.0001) {
      this.complete(it);
      return;
    }

    this.tickHelper(dt);
  }

  /** 보조 작업대 — 두 번째 물건을 부수기로 동시 처리 (처리량만 늘리고 판단은 대신하지 않는다). */
  private tickHelper(dt: number): void {
    const h = this.helper;
    if (!h) return;

    const dmg = Math.min(h.hp, this.workshop.smashDps * dt);
    h.hp -= dmg;
    h.totalDmg += dmg;
    h.smashDmg += dmg;

    h.dropAcc += (this.balance.feel.dropsPerMachine * dmg) / h.maxHp;
    while (h.dropAcc >= 1) {
      h.dropAcc -= 1;
      this.events.onDrop?.(h, false);
    }

    if (!h.findRolled && h.totalDmg >= h.maxHp * 0.5) {
      h.findRolled = true;
      h.pendingFind = this.rollFind(h);
      if (h.pendingFind) this.events.onFind?.(h.pendingFind);
    }

    if (h.hp <= 0.0001) {
      // 보조가 끝낸 물건은 대기열에서 빼되, 메인 작업(queue[0])은 건드리지 않는다
      this.queue.splice(1, 1);
      this.completeInner(h);
      this.events.onItemDone?.(h);
    }
  }

  /** 발견 판정 — **처리 축이 확률을 크게 가른다** (부수면 망가진다). 난수 1~2회. */
  private rollFind(it: Item): string | null {
    const cond = this.balance.condition(it.conditionId);
    const stripFrac = it.totalDmg > 0 ? 1 - it.smashDmg / it.totalDmg : 0;
    const axisMult =
      this.balance.axis.smashFindMult +
      (this.balance.axis.stripFindMult - this.balance.axis.smashFindMult) * stripFrac;
    const chance =
      (this.balance.find.baseChance + this.balance.find.gradeBonus * (it.grade - 1)) *
      axisMult *
      cond.findMult *
      (1 + this.workshop.findBonus);
    if (this.rng.nextDouble() >= chance) return null;

    let total = 0;
    for (const f of this.balance.find.items) if (f.minGrade <= it.grade) total += f.weight;
    if (total <= 0) return null;
    let r = this.rng.next(total);
    for (const f of this.balance.find.items) {
      if (f.minGrade > it.grade) continue;
      r -= f.weight;
      if (r < 0) return f.id;
    }
    return null;
  }

  private complete(it: Item): void {
    this.completeInner(it);
    this.queue.shift();
    this.conveyorT = 0;
    this.settleT = this.balance.line.settleSeconds;
    this.events.onItemDone?.(it);
  }

  /** 정산만 수행 (라인 진행은 호출부가 담당) — 메인·보조 작업대가 공유한다. */
  private completeInner(it: Item): void {
    const cond = this.balance.condition(it.conditionId);
    const stripFrac = it.totalDmg > 0 ? 1 - it.smashDmg / it.totalDmg : 0;
    const axis = this.balance.axis;

    // 축 비율로 회수량 보간 — 겉은 부수고 안은 뜯는 혼합이 정상 플레이
    const scrapMult = axis.smashScrapMult + (axis.stripScrapMult - axis.smashScrapMult) * stripFrac;
    const partsMult = axis.smashPartsMult + (axis.stripPartsMult - axis.smashPartsMult) * stripFrac;

    const total = this.balance.yieldTotal(it.grade);
    const scrapVal = total * (1 - this.balance.machine.partsShare) * scrapMult * cond.scrapMult;
    const partsVal = total * this.balance.machine.partsShare * partsMult * cond.partsMult;

    this.workshop.earnScrap(scrapVal * this.workshop.scrapVal);
    this.workshop.earnParts(partsVal * this.workshop.partsVal);
    this.workshop.earnCash((scrapVal + partsVal) * this.workshop.cashVal); // 자원을 팔아 현금이 된다

    // 특수 자원은 **뜯기 비율만큼만** (부수면 못 쓴다)
    if (stripFrac > 0) {
      const sp = this.balance.special;
      this.workshop.earnSpecial(
        this.balance.specialQty(sp.copperBase, it.grade) * stripFrac,
        this.balance.specialQty(sp.boardsBase, it.grade) * stripFrac,
        this.balance.specialQty(sp.coresBase, it.grade) * stripFrac,
      );
    }

    if (it.pendingFind) {
      this.pendingPickup = it.pendingFind;
      // **회수액 기준**이다 — 매입가에 연동하면 등급 곡선을 타고 보상이 폭발한다(원본 시뮬 실측)
      this.pendingPickupCash =
        this.balance.yieldTotal(it.grade) * (this.balance.findItemOf(it.pendingFind)?.cashMult ?? 1);
    }

    this.workshop.d.totalMachines++;
    this.tryUnlockNextGrade();
  }

  /**
   * 다음 등급 해금 — **누적 수입** 기준.
   * 보유 현금으로 판정하면 계속 매입하는 정상 플레이에서 현금이 쌓이지 않아
   * 등급이 영영 안 열린다 (원본 시뮬 실측: 등급2에 16분).
   */
  private tryUnlockNextGrade(): void {
    const next = this.workshop.d.maxGrade + 1;
    if (next > this.balance.machine.gradeCap) return;
    if (this.workshop.d.lifetimeCash >= this.balance.buyPrice(next) * this.balance.machine.unlockMargin) {
      this.workshop.d.maxGrade = next;
    }
  }

  /** 발견물 수령 — 현금 + 도감 등록 (영구 패시브). */
  claimFind(): boolean {
    if (!this.pendingPickup) return false;
    this.workshop.earnCash(this.pendingPickupCash);
    this.workshop.addCodex(this.pendingPickup);
    this.pendingPickup = null;
    this.pendingPickupCash = 0;
    return true;
  }

  // ---- 조회 (UI용) ----

  get progress(): number {
    const it = this.current;
    return !it || it.maxHp <= 0 ? 0 : 1 - it.hp / it.maxHp;
  }

  /** 현재 물건을 지금 축으로 끝까지 처리할 때 남은 초. */
  get secondsLeft(): number {
    const it = this.current;
    if (!it) return 0;
    const dps = this.mode === "strip" ? this.workshop.stripDps : this.workshop.smashDps;
    return dps <= 0 ? 0 : it.hp / dps;
  }
}
