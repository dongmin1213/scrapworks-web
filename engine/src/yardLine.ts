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

/**
 * float32로 내린다 — **원작에서 컨베이어·정산 텀은 `float`이다.**
 *
 * TS의 number는 배정밀도라 그대로 누적하면 원작과 조금씩 갈라지고, 컨베이어가
 * 1.0에 닿는 프레임이 한 칸 어긋난다. 그 한 칸이 매입 타이밍을 바꾸고, 매입 타이밍이
 * 난수 소비를 바꾸고, 결국 세션 전체가 달라진다.
 * (시나리오 골든이 t=1초에서 1e-7 차이로 이걸 잡아냈다.)
 *
 * 체력·데미지·재화는 원작에서도 `double`이므로 여기를 통과시키지 않는다.
 */
const f32 = Math.fround;

/** 매대에 걸리는 등급 수 — 원작 `BuyUI`가 1~6을 만든다. */
const OFFER_ROWS = 6;

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

/**
 * 매대 한 줄 — **등급마다 매물이 하나씩 걸려 있다.**
 * 상태는 화면이 열릴 때 굴려 고정되고, **사려고 눌러 성공했을 때만** 새 매물이 걸린다.
 */
export interface BuyOffer {
  grade: number;
  conditionId: string;
}

export class YardLine {
  /**
   * 매대 재고 — 원작 `BuyUI.BuildRow`가 화면 생성 시 등급 1~6의 상태를 **여섯 번 굴려**
   * 각 행에 고정하고, 구매 성공 시에만 그 행을 다시 굴린다(`OnBuy`).
   *
   * 처음엔 이걸 화면 쪽에 두지 않고 **누를 때마다 굴렸다.** 그러면 세 가지가 어긋난다:
   *  - 표시 가격이 항상 기본가라 실제 결제액(상태 배수)과 다르다 — 눌렀는데 조용히 실패한다
   *  - 잔액·대기열 부족으로 실패해도 **난수를 이미 써 버린다**
   *  - 그 뒤의 발견물 난수까지 전부 한 칸씩 밀린다
   * 재고는 규칙이지 화면 장식이 아니므로 엔진이 소유한다.
   */
  readonly offers: BuyOffer[] = [];

  /** [0]이 작업 중인 물건 */
  readonly queue: Item[] = [];
  mode: Axis = "smash";
  /** 반입 이동 진행 (0~1) */
  conveyorT = 0;
  pendingPickup: string | null = null;
  pendingPickupCash = 0;
  /** 수령 대기 발견물이 나온 등급 — **금액을 다시 계산하기 위해** 저장한다. */
  pendingPickupGrade = 0;

  private settleT = 0;

  constructor(
    private readonly balance: Balance,
    private readonly workshop: Workshop,
    private readonly rng: Rng,
    private readonly events: YardEvents = {},
  ) {
    // 원작 BuildRow와 **같은 순서로** 등급 1~6을 굴린다 — 순서가 곧 난수 수열이다
    for (let g = 1; g <= OFFER_ROWS; g++) {
      this.offers.push({ grade: g, conditionId: this.rollCondition() });
    }
  }

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

  /**
   * 매대에서 산다 — 원작 `BuyUI.OnBuy`. **성공했을 때만** 그 행에 새 매물을 굴린다.
   * 화면은 이 메서드만 부르면 되고 상태를 스스로 굴리지 않는다.
   */
  buyOffer(grade: number): boolean {
    const offer = this.offers.find((o) => o.grade === grade);
    if (!offer) return false;
    if (!this.buy(offer.grade, offer.conditionId)) return false;
    offer.conditionId = this.rollCondition(); // 산 매물은 나가고 새 매물이 걸린다
    return true;
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

  /**
   * 한 프레임 진행.
   *
   * **`dt`를 진입 시점에 float32로 내린다** — 원작 시그니처가 `Tick(float dt)`이기 때문이다.
   * 브라우저의 rAF는 배정밀도 dt를 주므로 그대로 쓰면 원작과 미세하게 다른 값으로 계산되고,
   * 골든은 float32 dt로 대조하니 **테스트는 통과하는데 실제 게임만 다른** 최악의 형태가 된다.
   * 여기서 한 번 내리면 그 간극이 사라진다 (적대적 리뷰 R5:
   * dt=1/60로 30틱 후 HP가 83.99999968… vs 83.99999999…로 갈렸다).
   */
  tick(rawDt: number): void {
    const dt = f32(rawDt);
    if (this.queue.length === 0) return;

    if (this.settleT > 0) {
      this.settleT = f32(this.settleT - dt);
      if (this.settleT > 0) return;
    }

    // 컨베이어 이동 — 도착해야 해체가 시작된다
    if (this.conveyorT < 1) {
      // 원작: `1f / Math.Max(0.05f, conveyorSeconds / (1f + (float)NodeSum(...)))`
      // conveyorSeconds는 Balance가 이미 float32로 내려 준다.
      const speed = f32(
        1 /
          Math.max(
            0.05,
            f32(this.balance.line.conveyorSeconds / f32(1 + this.workshop.nodeSum("conveyorPct"))),
          ),
      );
      this.conveyorT = Math.min(1, f32(this.conveyorT + f32(speed * dt)));
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
    this.settleT = this.balance.line.settleSeconds; // Balance가 float32로 준다
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
      this.pendingPickupGrade = it.grade;
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
    this.pendingPickupGrade = 0;
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

  // ---- 저장 ----

  /**
   * 라인 상태 전체 — **저장에 이게 없으면 새로고침이 진행 중인 작업을 삼킨다.**
   *
   * 처음엔 `Workshop.d`만 저장했다. 그러면 대기열·체력·컨베이어·모드·수령 대기 중인
   * 발견물이 통째로 사라진다 — 등급 6짜리를 90% 해체한 상태에서 탭을 닫으면 매입가는
   * 이미 냈는데 물건만 없어진다. 명백한 손실이고, 유저 입장에서는 버그다.
   */
  saveState(): YardState {
    return {
      offers: this.offers.map((o) => ({ ...o })),
      queue: this.queue.map((it) => ({ ...it })),
      mode: this.mode,
      conveyorT: this.conveyorT,
      settleT: this.settleT,
      pendingPickup: this.pendingPickup,
      pendingPickupCash: this.pendingPickupCash,
      pendingPickupGrade: this.pendingPickupGrade,
    };
  }

  /**
   * 저장된 라인 상태를 적용한다. **검증에 실패한 필드는 조용히 버리고 기본값으로 간다** —
   * 손상된 세이브 하나가 게임 전체를 흰 화면으로 만드는 것이 최악이다.
   * 반환값은 "온전히 복원했는가" — false면 호출부가 유저에게 알릴 수 있다.
   */
  restoreState(v: unknown): boolean {
    if (typeof v !== "object" || v === null) return false;
    const s = v as Partial<YardState>;
    let intact = true;

    // **매대는 등급 1~6이 정확히 한 번씩 있어야 한다.** 개수만 맞추거나 빈 배열을
    // 통과시키면, 생성자가 임시 난수로 만든 매물이 그대로 남은 채 난수만 저장 시점으로
    // 되감긴다 — 손상 알림도 없이 매대와 수열의 시점이 어긋난다 (적대적 리뷰 R6).
    const offerGrades = Array.isArray(s.offers)
      ? s.offers.map((o) => (o as BuyOffer | undefined)?.grade)
      : [];
    const offersComplete =
      offerGrades.length === this.offers.length &&
      this.offers.every((row) => offerGrades.filter((g) => g === row.grade).length === 1);

    // **전부 적용하거나 전부 두거나** — 한 칸만 손상돼도 나머지를 덮으면,
    // 그 한 칸은 생성자가 굴린 임시 값이고 나머지는 저장값인데 난수는 저장 시점으로
    // 되감긴다. 재고와 수열의 시점이 어긋난 채로 계속 돈다 (적대적 리뷰 R7-19).
    const restorable =
      offersComplete &&
      (s.offers as BuyOffer[]).every(
        (o) => typeof o.conditionId === "string" && this.hasCondition(o.conditionId),
      );

    if (restorable) {
      for (const o of s.offers as BuyOffer[]) {
        this.offers.find((x) => x.grade === o.grade)!.conditionId = o.conditionId;
      }
    } else {
      intact = false;
    }

    this.queue.length = 0;
    if (Array.isArray(s.queue)) {
      for (const raw of s.queue) {
        // **대기열 칸수를 넘길 수 없다.** 넘기면 규칙상 불가능한 상태이고,
        // 수천 개를 넣으면 매 프레임 그 전부를 도는 상태가 된다.
        if (this.queue.length >= this.queueSlots) {
          intact = false;
          break;
        }
        const it = this.sanitizeItem(raw);
        if (it) this.queue.push(it);
        else intact = false;
      }
    } else {
      intact = false;
    }

    this.mode = s.mode === "strip" ? "strip" : "smash";
    this.conveyorT = clamp01(num(s.conveyorT, 0));
    this.settleT = Math.max(0, num(s.settleT, 0));
    // 수령 대기 발견물 — **금액은 저장값을 믿지 않고 다시 계산한다.**
    // 전에는 "유한한 0 이상"이기만 하면 그대로 지급했다. 유효한 발견물 id와 1e300을
    // 넣으면 그대로 들어온다 (적대적 리뷰 R7-17). 금액은 등급과 cashMult가 정하는 값이므로
    // **어느 등급에서 나왔는지**를 함께 저장하고 그걸로 다시 만든다.
    this.pendingPickup =
      typeof s.pendingPickup === "string" && this.balance.findItemOf(s.pendingPickup)
        ? s.pendingPickup
        : null;

    if (this.pendingPickup) {
      const cashMult = this.balance.findItemOf(this.pendingPickup)?.cashMult ?? 1;
      // **v3 파일에는 등급이 없다.** 없다고 1로 두면 고등급 발견물의 보상이
      // 조용히 깎인다 — 기존 플레이어가 손해를 본다 (적대적 리뷰 R8-10).
      // 저장된 금액을 **그대로 믿지는 않되**(R7-17), 그 금액이 어느 등급에서
      // 나왔는지를 역산해 되찾는다. 등급은 유한한 정수 범위라 맞춰 볼 수 있다.
      const grade = Number.isFinite(num(s.pendingPickupGrade, NaN))
        ? Math.min(this.balance.machine.gradeCap, Math.max(1, Math.floor(num(s.pendingPickupGrade, 1))))
        : this.gradeFromCash(num(s.pendingPickupCash, NaN), cashMult);
      this.pendingPickupGrade = grade;
      this.pendingPickupCash = this.balance.yieldTotal(grade) * cashMult;
    } else {
      this.pendingPickupGrade = 0;
      this.pendingPickupCash = 0;
    }

    return intact;
  }

  /**
   * 저장된 금액에서 등급을 되찾는다 — <b>v3 세이브를 위한 마이그레이션.</b>
   *
   * 금액은 `yieldTotal(grade) × cashMult`이고 `yieldTotal`은 등급에 대해 단조 증가한다.
   * 따라서 가능한 등급을 훑어 **가장 가까운 하나**를 고를 수 있다. 금액을 그대로
   * 쓰지 않는 이유는 R7-17과 같다 — 조작된 큰 수를 그대로 지급하지 않기 위해서다.
   * 어느 등급으로도 설명되지 않는 금액(위조·손상)은 1로 떨어진다.
   */
  private gradeFromCash(cash: number, cashMult: number): number {
    if (!Number.isFinite(cash) || cash <= 0 || cashMult <= 0) return 1;
    let best = 1;
    let bestDiff = Infinity;
    for (let g = 1; g <= this.balance.machine.gradeCap; g++) {
      const diff = Math.abs(this.balance.yieldTotal(g) * cashMult - cash);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = g;
      }
    }
    // 상대 오차가 크면 어느 등급의 값도 아니다 — 조작된 값으로 보고 최소로 준다
    return bestDiff <= Math.abs(cash) * 0.01 ? best : 1;
  }

  private hasCondition(id: string): boolean {
    return this.balance.conditions.some((c) => c.id === id);
  }

  /** 저장된 물건 하나를 검증한다 — 하나라도 이상하면 그 물건만 버린다(게임은 계속된다). */
  private sanitizeItem(raw: unknown): Item | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Partial<Item>;
    // 등급은 **상한이 있다** — 넘기면 `buyPrice`·`durability`의 지수가 폭주해 Infinity가 된다
    if (!Number.isFinite(r.grade)) return null;
    const grade = Math.floor(r.grade as number);
    if (grade < 1 || grade > this.balance.machine.gradeCap) return null;
    if (typeof r.conditionId !== "string" || !this.hasCondition(r.conditionId)) return null;

    // **내구도는 등급과 상태가 정한다.** 저장값을 그대로 믿으면 조작한 maxHp로
    // 즉시 완료시켜 무한히 정산할 수 있다 — 계산값으로 덮는다.
    const cond = this.balance.condition(r.conditionId);
    const maxHp = this.balance.durability(grade) * cond.durMult;
    if (!(maxHp > 0)) return null;

    // **보존식이 규칙이다: `hp + totalDmg == maxHp`.**
    // 둘을 따로 clamp하면 `hp:0, totalDmg:0`이 통과하고, 그 물건은 **아무 처리 없이**
    // 다음 틱에 정산된다 — 매입가만 내고 전액을 회수하는 무한 루프가 된다
    // (적대적 리뷰 R7-16). hp를 신뢰하고 totalDmg는 **계산한다.**
    const hp = Math.max(0, Math.min(maxHp, num(r.hp, maxHp)));
    const totalDmg = maxHp - hp;
    return {
      grade,
      conditionId: r.conditionId,
      revealed: r.revealed === true,
      maxHp,
      hp,
      // 부수기 몫이 전체를 넘을 수 없다 — 넘으면 stripFrac이 음수가 되고 정산 배수가 뒤집힌다
      smashDmg: Math.max(0, Math.min(totalDmg, num(r.smashDmg, 0))),
      totalDmg,
      // dropAcc는 항상 1 미만이다(1이 되면 그 자리에서 드랍으로 소비된다)
      dropAcc: Math.min(0.999, Math.max(0, num(r.dropAcc, 0))),
      pendingFind:
        typeof r.pendingFind === "string" && this.balance.findItemOf(r.pendingFind)
          ? r.pendingFind
          : null,
      findRolled: r.findRolled === true,
    };
  }
}

/** 직렬화된 라인 상태 — 세이브가 이걸 통째로 싣는다. */
export interface YardState {
  offers: BuyOffer[];
  queue: Item[];
  mode: Axis;
  conveyorT: number;
  settleT: number;
  pendingPickup: string | null;
  pendingPickupCash: number;
  /** 발견물이 나온 등급 — 복원 시 금액을 다시 계산하는 근거 */
  pendingPickupGrade: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
