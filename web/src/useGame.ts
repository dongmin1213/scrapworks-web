import {
  Balance,
  DotNetRandom,
  Workshop,
  YardLine,
  newGame,
  type BalanceData,
  type SaveData,
} from "@scrapworks/engine";
import balanceJson from "@scrapworks/engine/content/balance.json";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 게임 루프 — 엔진을 굴리고 화면이 읽을 스냅샷을 만든다.
 *
 * **엔진은 시간을 모른다.** `tick(dt)`만 받는다 — 그래서 골든 테스트가 브라우저 없이
 * 규칙을 돌릴 수 있고, 여기서만 requestAnimationFrame과 이어 붙인다.
 *
 * 저장은 localStorage다. **같은 오리진**에서 서빙되기 때문에 Safari가 막지 않는다
 * (크로스사이트 iframe이면 서드파티 스토리지로 분류돼 통째로 날아간다 — 플랫폼 규약).
 */

const SAVE_KEY = "scrapworks.save.v1";

export interface GameSnapshot {
  cash: number;
  scrap: number;
  parts: number;
  copper: number;
  boards: number;
  cores: number;
  maxGrade: number;
  totalMachines: number;
  codex: string[];
  mode: "smash" | "strip";
  queue: {
    grade: number;
    conditionId: string;
    revealed: boolean;
    hpFrac: number;
  }[];
  conveyorT: number;
  progress: number;
  secondsLeft: number;
  queueSlots: number;
  pendingPickup: string | null;
  pendingPickupCash: number;
  /** 다음 매입 후보 — 등급별 가격 (상태는 매입 시점에 굴린다) */
  buyable: { grade: number; price: number; affordable: boolean }[];
}

function loadSave(balance: Balance): SaveData {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      // 저장 구조가 늘어나도 옛 저장이 깨지지 않게 기본값 위에 얹는다
      return { ...newGame(balance), ...parsed };
    }
  } catch {
    // 손상된 저장은 버린다 — 여기서 멈추면 게임을 아예 못 한다
  }
  return newGame(balance);
}

export function useGame() {
  const balanceRef = useRef<Balance>();
  const workshopRef = useRef<Workshop>();
  const lineRef = useRef<YardLine>();

  if (!balanceRef.current) {
    const balance = new Balance(balanceJson as unknown as BalanceData);
    const workshop = new Workshop(balance, loadSave(balance));
    // 시드 없는 실플레이는 매번 다른 수열 — 골든 테스트만 고정 시드를 쓴다
    const rng = new DotNetRandom((Math.random() * 0x7fffffff) | 0);
    balanceRef.current = balance;
    workshopRef.current = workshop;
    lineRef.current = new YardLine(balance, workshop, rng);
  }

  const balance = balanceRef.current;
  const workshop = workshopRef.current!;
  const line = lineRef.current!;

  const snapshot = useCallback((): GameSnapshot => {
    const maxBuy = Math.min(workshop.d.maxGrade, balance.machine.gradeCap);
    const buyable = [];
    for (let g = Math.max(1, maxBuy - 2); g <= maxBuy; g++) {
      const price = balance.buyPrice(g);
      buyable.push({ grade: g, price, affordable: workshop.cash >= price && !line.queueFull });
    }
    return {
      cash: workshop.d.cash,
      scrap: workshop.d.scrap,
      parts: workshop.d.parts,
      copper: workshop.d.copper,
      boards: workshop.d.boards,
      cores: workshop.d.cores,
      maxGrade: workshop.d.maxGrade,
      totalMachines: workshop.d.totalMachines,
      codex: [...workshop.d.codex],
      mode: line.mode,
      queue: line.queue.map((it) => ({
        grade: it.grade,
        conditionId: it.conditionId,
        revealed: it.revealed,
        hpFrac: it.maxHp > 0 ? it.hp / it.maxHp : 0,
      })),
      conveyorT: line.conveyorT,
      progress: line.progress,
      secondsLeft: line.secondsLeft,
      queueSlots: line.queueSlots,
      pendingPickup: line.pendingPickup,
      pendingPickupCash: line.pendingPickupCash,
      buyable,
    };
  }, [balance, workshop, line]);

  const [state, setState] = useState<GameSnapshot>(snapshot);

  // 게임 루프 — dt는 **초 단위**이고 탭이 백그라운드로 갔다 오면 큰 값이 들어온다.
  // 상한을 두지 않으면 복귀 순간 한 프레임에 몇 분치가 처리돼 화면이 건너뛴다.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      line.tick(dt);
      setState(snapshot());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [line, snapshot]);

  // 주기 저장 — 밸런스의 saveIntervalSec을 따른다(수치는 balance.json이 소유)
  useEffect(() => {
    const id = window.setInterval(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(workshop.d));
      } catch {
        // 저장 실패(프라이빗 모드 등)는 게임을 막지 않는다
      }
    }, balance.line.saveIntervalSec * 1000);
    return () => window.clearInterval(id);
  }, [balance, workshop]);

  // 탭을 떠날 때도 한 번 — 주기 저장만으로는 마지막 몇 초를 잃는다
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(workshop.d));
      } catch {
        /* 위와 같음 */
      }
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
    };
  }, [workshop]);

  const buy = useCallback(
    (grade: number) => {
      // 상태는 **매입 시점에 굴린다** — 원본과 같은 순서여야 한다
      const cond = line.rollCondition();
      line.buy(grade, cond);
      setState(snapshot());
    },
    [line, snapshot],
  );

  const setMode = useCallback(
    (mode: "smash" | "strip") => {
      line.setMode(mode);
      setState(snapshot());
    },
    [line, snapshot],
  );

  const claimFind = useCallback(() => {
    line.claimFind();
    setState(snapshot());
  }, [line, snapshot]);

  return { state, balance, buy, setMode, claimFind };
}
