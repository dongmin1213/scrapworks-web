import {
  Balance,
  DotNetRandom,
  Session,
  Workshop,
  YardLine,
  newGame,
  sanitizeSave,
  SAVE_VERSION,
  type BalanceData,
  type NodeDef,
  type OperatorDef,
  type RngState,
  type SpecialCost,
  type SaveData,
  type YardState,
} from "@scrapworks/engine";
import balanceJson from "@scrapworks/engine/content/balance.json";
import { t } from "./strings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 게임 루프 — 엔진을 굴리고 화면이 읽을 스냅샷을 만든다.
 *
 * **엔진은 시간을 모른다.** `tick(dt)`만 받는다 — 그래서 골든 테스트가 브라우저 없이
 * 규칙을 돌릴 수 있고, 여기서만 requestAnimationFrame과 이어 붙인다.
 *
 * 저장은 localStorage다. **같은 오리진**에서 서빙되기 때문에 Safari가 막지 않는다
 * (크로스사이트 iframe이면 서드파티 스토리지로 분류돼 통째로 날아간다 — 플랫폼 규약).
 */

const SAVE_KEY = "scrapworks.save.v3";
/** 옛 키 — 한 번 읽어 옮기고 지운다. 유저의 진행을 버리지 않는다. */
const LEGACY_KEYS = ["scrapworks.save.v1", "scrapworks.save.v2"];

/**
 * 탭 소유권 — **같은 게임을 두 탭에서 열면 서로를 덮어쓴다.**
 *
 * 두 탭이 각자 자기 메모리를 주기적으로 저장하면, 나중에 저장한 쪽이 다른 쪽의 진행을
 * 통째로 지운다. 탭 A에서 10분 놀고 탭 B(오래된 상태)가 저장하는 순간 10분이 사라진다.
 * 그래서 **쓰기 권한을 한 탭만 갖는다**: 가장 마지막에 활성화된 탭이 소유권을 가져가고,
 * 잃은 탭은 읽기 전용으로 내려가 그 사실을 화면에 알린다.
 */
const LEASE_KEY = "scrapworks.lease";

/** 프레임마다 리렌더하지 않는다 — 60Hz setState는 React가 병목이 되고 배터리를 태운다. */
const UI_HZ = 10;

/**
 * dt 상한 — **원작(Unity)의 `maximumDeltaTime` 기본값과 같은 값**을 쓴다.
 * 탭이 백그라운드에 있다 돌아오면 큰 값이 들어오는데, 상한이 없으면 한 프레임에 몇 분치가
 * 처리돼 화면이 건너뛴다. 그 시간은 버리는 게 아니라 **야간 작업조 정산**이 따로 갚는다.
 */
const MAX_DT = 0.33333334;

export interface GameSnapshot {
  cash: number;
  scrap: number;
  parts: number;
  copper: number;
  boards: number;
  cores: number;
  cumScrap: number;
  maxGrade: number;
  totalMachines: number;
  codexIds: string[];
  findCount: number;
  mode: "smash" | "strip";
  queue: {
    grade: number;
    conditionId: string;
    revealed: boolean;
    hpFrac: number;
  }[];
  helperIndex: number | null;
  conveyorT: number;
  progress: number;
  secondsLeft: number;
  queueSlots: number;
  pendingPickup: string | null;
  pendingPickupCash: number;
  /**
   * 매대 — **걸려 있는 매물 그대로**다. 가격은 상태 배수가 곱해진 실제 결제액이고,
   * 상태 id도 같이 준다. 기본가만 보여주면 눌렀을 때 조용히 실패한다.
   */
  offers: {
    grade: number;
    conditionId: string;
    price: number;
    affordable: boolean;
    locked: boolean;
  }[];
  /** 스킬 노드 — 원작 SkillsUI가 그리는 것 그대로 */
  nodes: {
    def: NodeDef;
    level: number;
    cost: number;
    maxed: boolean;
    affordable: boolean;
  }[];
  /** 공구 두 축 */
  tools: {
    smash: boolean;
    label: string;
    tier: number;
    tierCount: number;
    cost: number;
    special: SpecialCost;
    maxed: boolean;
    affordable: boolean;
  }[];
  /** 작업자 사다리 */
  ops: { rank: number; def: OperatorDef; owned: boolean; equipped: boolean }[];
  nextOpCost: number | null;
  canBuyOp: boolean;
  /** 공방 이전(환생) */
  rebirth: { certs: number; pending: number; mult: number; can: boolean };
  /** 이 탭이 저장 권한을 갖고 있는가 — false면 다른 탭이 진행 중이다 */
  hasLease: boolean;
  /** 세이브 일부를 복구했다 (손상 감지) */
  saveRecovered: boolean;
  /** 돌아왔을 때 야간 작업조가 벌어둔 현금. 0이면 알릴 것이 없다. */
  nightCash: number;
}

/** 저장 파일 — 지갑만이 아니라 **세션 전체**를 싣는다. */
interface SaveFile {
  version: number;
  d: SaveData;
  line: YardState;
  rng: RngState;
  /** 저장 시각(ms) — 야간 작업조 정산과 시계 되돌림 감지의 기준 */
  savedAtMs: number;
  /** 리비전 — 다른 탭이 더 새 저장을 남겼는지 판별한다 */
  rev: number;
}

function readRaw(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // 손상·비활성 스토리지 — 여기서 멈추면 게임을 아예 못 한다
  }
}

function loadSaveFile(): Partial<SaveFile> | null {
  const cur = readRaw(SAVE_KEY);
  if (cur && typeof cur === "object") return cur as Partial<SaveFile>;
  for (const k of LEGACY_KEYS) {
    const old = readRaw(k);
    // v1/v2는 SaveData를 그대로 넣었다 — 지갑만 살리고 라인은 새로 시작한다
    if (old && typeof old === "object") return { d: old as SaveData };
  }
  return null;
}

export function useGame() {
  const boot = useRef<{
    balance: Balance;
    workshop: Workshop;
    line: YardLine;
    session: Session;
    rng: DotNetRandom;
    recovered: boolean;
    nightCash: number;
    rev: number;
  }>();

  if (!boot.current) boot.current = bootstrap();
  const { balance, workshop, line, session } = boot.current;

  const revRef = useRef(boot.current.rev);
  const [hasLease, setHasLease] = useState(true);
  const leaseId = useMemo(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`, []);

  const snapshot = useCallback(
    (lease: boolean): GameSnapshot => {
      const helperIdx = line.helper ? 1 : null;
      return {
        cash: workshop.d.cash,
        scrap: workshop.d.scrap,
        parts: workshop.d.parts,
        copper: workshop.d.copper,
        boards: workshop.d.boards,
        cores: workshop.d.cores,
        cumScrap: workshop.d.cumScrap,
        maxGrade: workshop.d.maxGrade,
        totalMachines: workshop.d.totalMachines,
        codexIds: [...workshop.d.codexIds],
        findCount: workshop.d.findCount,
        mode: line.mode,
        queue: line.queue.map((it) => ({
          grade: it.grade,
          conditionId: it.conditionId,
          revealed: it.revealed,
          hpFrac: it.maxHp > 0 ? it.hp / it.maxHp : 0,
        })),
        helperIndex: helperIdx,
        conveyorT: line.conveyorT,
        progress: line.progress,
        secondsLeft: line.secondsLeft,
        queueSlots: line.queueSlots,
        pendingPickup: line.pendingPickup,
        pendingPickupCash: line.pendingPickupCash,
        offers: line.offers.map((o) => {
          const price = line.priceOf(o.grade, o.conditionId);
          return {
            grade: o.grade,
            conditionId: o.conditionId,
            price,
            // **실제 결제액으로 판정한다** — 기본가로 판정하면 눌렀을 때 조용히 실패한다
            affordable: workshop.cash >= price && !line.queueFull,
            locked: o.grade > line.maxBuyableGrade,
          };
        }),
        nodes: balance.skill.nodes.map((def) => ({
          def,
          level: workshop.nodeLv(def.id),
          cost: workshop.nodeCost(def.id),
          maxed: workshop.nodeMaxed(def.id),
          affordable: workshop.canBuyNode(def.id),
        })),
        tools: [true, false].map((smash) => ({
          smash,
          label: smash ? t("run.smash") : t("run.strip"),
          tier: smash ? workshop.smashTier : workshop.stripTier,
          tierCount: balance.tool.tierCount,
          cost: workshop.toolCost(smash),
          special: workshop.toolSpecial(smash) ?? { copper: 0, boards: 0, cores: 0 },
          maxed: workshop.toolMaxed(smash),
          affordable: workshop.canBuyTool(smash),
        })),
        ops: balance.shop.operators.map((def, i) => ({
          rank: i + 1,
          def,
          owned: i + 1 <= workshop.d.opRank,
          equipped: i + 1 === workshop.d.opEquipped,
        })),
        nextOpCost: workshop.ladderDone ? null : workshop.nextOpCost,
        canBuyOp: workshop.canBuyOp,
        rebirth: {
          certs: workshop.certs,
          pending: workshop.pendingCerts,
          mult: workshop.certMult,
          can: workshop.canRebirth,
        },
        hasLease: lease,
        saveRecovered: boot.current!.recovered,
        nightCash: boot.current!.nightCash,
      };
    },
    [workshop, line],
  );

  const [state, setState] = useState<GameSnapshot>(() => snapshot(true));

  // ── 탭 소유권 ──
  //
  // 처음엔 포커스가 올 때마다 소유권을 다시 가져갔다. **그건 아무것도 막지 못한다** —
  // 오래된 탭이 포커스를 받는 순간 소유권을 되찾고, 그 탭의 **메모리 안 옛 상태**를
  // 최신 저장 위에 덮어쓴다. 탭 A에서 10분 논 뒤 탭 B를 클릭하면 10분이 사라진다.
  //
  // 그래서 규칙을 뒤집었다: **한 번 뺏기면 새로고침 전까지 되찾지 않는다.**
  // 이 탭의 메모리는 이미 낡았고, 낡은 상태로는 무엇을 해도 옳지 않다.
  useEffect(() => {
    const stale = () => {
      // 저장된 리비전이 우리보다 앞서 있으면 우리 메모리가 낡은 것이다
      const file = readRaw(SAVE_KEY) as Partial<SaveFile> | null;
      return typeof file?.rev === "number" && file.rev > revRef.current;
    };

    const claim = () => {
      try {
        localStorage.setItem(LEASE_KEY, leaseId);
      } catch {
        /* 스토리지가 없으면 소유권 개념도 없다 — 혼자 도는 것으로 본다 */
      }
    };
    claim();

    // 다른 탭이 소유권을 가져가면 storage 이벤트가 온다 (같은 탭에서는 발생하지 않는다)
    const onStorage = (e: StorageEvent) => {
      if (e.key === LEASE_KEY && e.newValue && e.newValue !== leaseId) setHasLease(false);
      // 다른 탭이 **저장**하면 그 순간 우리 상태가 낡는다 — 리스와 별개로 확인한다
      if (e.key === SAVE_KEY && stale()) setHasLease(false);
    };

    // 돌아왔을 때 되찾는 것은 **우리가 여전히 최신일 때만**이다
    const onFocus = () => {
      if (stale()) {
        setHasLease(false);
        return;
      }
      claim();
      setHasLease(true);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [leaseId]);

  const save = useCallback(() => {
    if (!hasLease) return; // 소유권 없는 탭은 쓰지 않는다
    try {
      // **쓰기 직전에 한 번 더 본다.** 리스는 이벤트로 오는데, 이벤트가 늦거나
      // 스토리지 이벤트를 못 받는 상황(같은 탭 다중 인스턴스)에서는 리스만으로 부족하다.
      // 저장된 리비전이 우리보다 앞서면 우리가 낡은 것이므로 쓰지 않는다.
      const existing = readRaw(SAVE_KEY) as Partial<SaveFile> | null;
      if (typeof existing?.rev === "number" && existing.rev > revRef.current) {
        setHasLease(false);
        return;
      }
      const file: SaveFile = {
        version: SAVE_VERSION,
        d: workshop.d,
        line: line.saveState(),
        rng: boot.current!.rng.saveState(),
        savedAtMs: Date.now(),
        rev: ++revRef.current,
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(file));
      for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    } catch {
      // 저장 실패(프라이빗 모드·용량 초과)는 게임을 막지 않는다
    }
  }, [hasLease, workshop, line]);

  // ── 게임 루프 ──
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let sinceRender = 0;
    const renderEvery = 1 / UI_HZ;

    const loop = (now: number) => {
      const dt = Math.min(MAX_DT, (now - last) / 1000);
      last = now;
      // **Session이 원작 GameMain.Update의 순서를 소유한다** (tick → autoBuy).
      // 여기서 line.tick만 부르면 자동매입 노드를 사도 아무 일도 일어나지 않는다.
      session.tick(dt);

      // **프레임마다 setState하지 않는다.** 규칙은 60Hz로 돌고 화면만 10Hz로 따라간다.
      sinceRender += dt;
      if (sinceRender >= renderEvery) {
        sinceRender = 0;
        setState(snapshot(hasLease));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [session, snapshot, hasLease]);

  // 주기 저장 — 밸런스의 saveIntervalSec을 따른다(수치는 balance.json이 소유)
  useEffect(() => {
    const id = window.setInterval(save, balance.line.saveIntervalSec * 1000);
    return () => window.clearInterval(id);
  }, [balance, save]);

  // 탭을 떠날 때도 한 번 — 주기 저장만으로는 마지막 몇 초를 잃는다
  useEffect(() => {
    const onHide = () => save();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [save]);

  // ── 조작 ──

  /**
   * 재화가 오가는 조작 뒤에는 **즉시 저장한다.**
   *
   * 주기 저장(20초)과 pagehide만 믿으면, 구매 직후 브라우저가 강제 종료될 때
   * 직전 저장 이후 진행이 통째로 사라진다 — 유저 입장에서는 돈만 없어진 것이다.
   * 원작도 BuyUI·YardUI·SkillsUI·ShopUI가 각각 성공 직후 `GameMain.Save()`를 부른다.
   */
  const commit = useCallback(() => {
    setState(snapshot(hasLease));
    save();
  }, [snapshot, hasLease, save]);

  /** 매대에서 산다 — **엔진이 재고를 소유한다.** 화면은 상태를 굴리지 않는다. */
  const buy = useCallback(
    (grade: number) => {
      if (line.buyOffer(grade)) commit();
      else setState(snapshot(hasLease));
    },
    [line, commit, snapshot, hasLease],
  );

  // 축 전환은 재화가 오가지 않는다 — 다음 주기 저장에 실려도 잃을 것이 없다
  const setMode = useCallback(
    (mode: "smash" | "strip") => {
      line.setMode(mode);
      setState(snapshot(hasLease));
    },
    [line, snapshot, hasLease],
  );

  const claimFind = useCallback(() => {
    if (line.claimFind()) commit();
  }, [line, commit]);

  const buyNode = useCallback(
    (id: string) => {
      if (workshop.buyNode(id)) commit();
    },
    [workshop, commit],
  );

  const buyTool = useCallback(
    (smash: boolean) => {
      if (workshop.buyTool(smash)) commit();
    },
    [workshop, commit],
  );

  const buyOp = useCallback(() => {
    if (workshop.buyOp()) commit();
  }, [workshop, commit]);

  const equipOp = useCallback(
    (rank: number) => {
      workshop.equip(rank);
      commit();
    },
    [workshop, commit],
  );

  const rebirth = useCallback(() => {
    if (workshop.doRebirth()) {
      // 환생은 라인도 비워야 한다 — 등급이 1로 돌아가는데 대기열에 등급 9가 남아 있으면
      // 살 수 없는 물건을 처리하고 있는 이상한 상태가 된다
      line.restoreState({ queue: [], offers: line.offers, mode: line.mode, conveyorT: 0, settleT: 0, pendingPickup: null, pendingPickupCash: 0 });
      commit();
    }
  }, [workshop, line, commit]);

  return { state, balance, workshop, buy, setMode, claimFind, buyNode, buyTool, buyOp, equipOp, rebirth };
}

/**
 * 부팅 — 세이브를 읽고 검증하고 야간 작업조를 정산한다.
 *
 * 순서가 중요하다: **검증 → 라인 복원 → 난수 복원 → 야간 정산.**
 * 야간 정산이 먼저면 복원되지 않은 상태로 수입을 계산해 값이 틀린다.
 */
function bootstrap() {
  const balance = new Balance(balanceJson as unknown as BalanceData);
  const file = loadSaveFile();

  const { d, intact } = file?.d ? sanitizeSave(balance, file.d) : { d: newGame(balance), intact: true };
  const workshop = new Workshop(balance, d);

  // 난수는 저장된 상태를 이어 붙인다 — 시드만 저장하면 새로고침으로 결과를 다시 뽑을 수 있다
  const rng = new DotNetRandom((Math.random() * 0x7fffffff) | 0);
  const savedRng = file?.rng && DotNetRandom.isValidState(file.rng) ? file.rng : null;

  const line = new YardLine(balance, workshop, rng);
  let recovered = !intact;
  if (file?.line) {
    if (!line.restoreState(file.line)) recovered = true;
  }

  // **난수 복원은 반드시 마지막이다.** YardLine 생성자가 매대 6칸을 굴리므로,
  // 복원을 먼저 하면 그 6회가 저장 시점 이후로 덧붙어 새로고침마다 수열이 6칸씩 밀린다.
  // 매대 자체는 위에서 저장값으로 덮어썼으니 그 6회는 버려야 하는 소비다.
  // (적대적 리뷰 R5 — 시드 12345에서 다음 값이 0.16595…여야 하는데 0.21598…이 나왔다)
  if (savedRng) rng.loadState(savedRng);

  // ── 야간 작업조 ──
  //
  // **시계 조작을 막지 못한다 — 막을 수 없다.** 기준이 기기 시각이고 세이브가
  // localStorage에 있는 한, 시각을 앞으로 돌리고 새로고침하면 상한만큼 받아갈 수 있다.
  // 되돌아간 시각(저장 시각이 미래)만 0으로 처리한다 — 그건 명백한 신호라 거를 뿐,
  // "조작 방지"가 아니다.
  //
  // 이 게임은 **로컬 진행이고 서버 랭킹에 올라가지 않는다.** 그래서 이 정도가 맞는
  // 선이다. 서버 점수를 붙이는 순간 야간 산출은 서버 시각으로 옮겨야 한다 —
  // 그때까지 "막았다"고 적어 두면 그 문장을 믿고 랭킹을 붙이게 된다(적대적 리뷰 R5).
  let nightCash = 0;
  const savedAt = typeof file?.savedAtMs === "number" ? file.savedAtMs : 0;
  const now = Date.now();
  if (savedAt > 0 && savedAt <= now) {
    nightCash = workshop.settleNight((now - savedAt) / 1000);
  }
  workshop.d.lastUtcMs = now;

  const session = new Session(balance, workshop, line);
  const rev = (file?.rev ?? 0) + 1;

  // **정산 결과를 즉시 쓴다.** 원작 `GameMain.SettleNight`도 곧바로 Save()를 부른다.
  // 다음 주기 저장까지 미루면 그 사이에 강제 종료됐을 때 **같은 savedAtMs로 또 정산**된다.
  if (nightCash > 0) {
    try {
      const file2: SaveFile = {
        version: SAVE_VERSION,
        d: workshop.d,
        line: line.saveState(),
        rng: rng.saveState(),
        savedAtMs: now,
        rev,
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(file2));
    } catch {
      /* 저장 못 해도 게임은 돈다 — 다음 주기가 다시 시도한다 */
    }
  }

  return { balance, workshop, line, session, rng, recovered, nightCash, rev };
}
