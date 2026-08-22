import {
  Balance,
  DotNetRandom,
  Workshop,
  YardLine,
  newGame,
  sanitizeSave,
  SAVE_VERSION,
  type BalanceData,
  type RngState,
  type SaveData,
  type YardState,
} from "@scrapworks/engine";
import balanceJson from "@scrapworks/engine/content/balance.json";
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
    rng: DotNetRandom;
    recovered: boolean;
    nightCash: number;
    rev: number;
  }>();

  if (!boot.current) boot.current = bootstrap();
  const { balance, workshop, line } = boot.current;

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
        hasLease: lease,
        saveRecovered: boot.current!.recovered,
        nightCash: boot.current!.nightCash,
      };
    },
    [workshop, line],
  );

  const [state, setState] = useState<GameSnapshot>(() => snapshot(true));

  // ── 탭 소유권 ──
  useEffect(() => {
    const claim = () => {
      try {
        localStorage.setItem(LEASE_KEY, leaseId);
      } catch {
        /* 스토리지가 없으면 소유권 개념도 없다 — 혼자 도는 것으로 본다 */
      }
      setHasLease(true);
    };
    claim();

    // 다른 탭이 소유권을 가져가면 storage 이벤트가 온다 (같은 탭에서는 발생하지 않는다)
    const onStorage = (e: StorageEvent) => {
      if (e.key === LEASE_KEY && e.newValue && e.newValue !== leaseId) setHasLease(false);
    };
    // 이 탭으로 돌아오면 다시 가져온다 — 마지막으로 본 탭이 정본이다
    const onFocus = () => claim();

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [leaseId]);

  const save = useCallback(() => {
    if (!hasLease) return; // 소유권 없는 탭은 쓰지 않는다 — 이게 덮어쓰기를 막는 전부다
    try {
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
      line.tick(dt);

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
  }, [line, snapshot, hasLease]);

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

  /** 매대에서 산다 — **엔진이 재고를 소유한다.** 화면은 상태를 굴리지 않는다. */
  const buy = useCallback(
    (grade: number) => {
      line.buyOffer(grade);
      setState(snapshot(hasLease));
    },
    [line, snapshot, hasLease],
  );

  const setMode = useCallback(
    (mode: "smash" | "strip") => {
      line.setMode(mode);
      setState(snapshot(hasLease));
    },
    [line, snapshot, hasLease],
  );

  const claimFind = useCallback(() => {
    line.claimFind();
    setState(snapshot(hasLease));
  }, [line, snapshot, hasLease]);

  const buyNode = useCallback(
    (id: string) => {
      if (workshop.buyNode(id)) setState(snapshot(hasLease));
    },
    [workshop, snapshot, hasLease],
  );

  const buyTool = useCallback(
    (smash: boolean) => {
      if (workshop.buyTool(smash)) setState(snapshot(hasLease));
    },
    [workshop, snapshot, hasLease],
  );

  const buyOp = useCallback(() => {
    if (workshop.buyOp()) setState(snapshot(hasLease));
  }, [workshop, snapshot, hasLease]);

  return { state, balance, workshop, buy, setMode, claimFind, buyNode, buyTool, buyOp };
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
  const rng =
    file?.rng && DotNetRandom.isValidState(file.rng)
      ? DotNetRandom.restore(file.rng)
      : new DotNetRandom((Math.random() * 0x7fffffff) | 0);

  const line = new YardLine(balance, workshop, rng);
  let recovered = !intact;
  if (file?.line) {
    if (!line.restoreState(file.line)) recovered = true;
  }

  // ── 야간 작업조 ──
  // **시계가 되돌아가면 0이다.** 기기 시각을 앞으로 돌려 보상을 뽑는 경로를 막는다
  // (원작 Clock 규약). 저장 시각이 미래면 그 자체가 조작 신호다.
  let nightCash = 0;
  const savedAt = typeof file?.savedAtMs === "number" ? file.savedAtMs : 0;
  const now = Date.now();
  if (savedAt > 0 && savedAt <= now) {
    nightCash = workshop.settleNight((now - savedAt) / 1000);
  }
  workshop.d.lastUtcMs = now;

  return { balance, workshop, line, rng, recovered, nightCash, rev: file?.rev ?? 0 };
}
