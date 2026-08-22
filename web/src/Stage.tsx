import { useEffect, useState, type ReactNode } from "react";
import styles from "./Stage.module.css";

/**
 * 게임 스테이지 — **390×844 논리 픽셀로 그리고, 화면에 맞게 통째로 스케일한다.**
 *
 * 원본은 **모바일 세로 전용**(iOS 우선)이다. 그 비율을 화면마다 다시 짜면 레이아웃이
 * 화면 수만큼 갈라지고, 어느 것이 맞는지 확인할 방법이 없어진다.
 * 그래서 논리 프레임 하나를 고정하고 통째로 스케일한다:
 *  - 레이아웃은 어떤 화면에서도 **정확히 같다**
 *  - 어떤 비율에서도 **잘리지 않는다** — 들어갈 만큼 줄인다
 *  - 데스크톱에서는 **키운다** — 세로 게임이 좁은 기둥으로 남지 않는다
 *
 * 소울 던전에서 가로 모드에 게임을 시작조차 할 수 없던 문제를 이 방식으로 고쳤다.
 * 기준 해상도만 다르다(그 게임은 375×667, 이 게임은 390×844 — 원본의 주 대상 기기).
 */

/** 기준 해상도 — 원본의 주 대상(iPhone 14 세로). */
export const DESIGN_WIDTH = 390;
export const DESIGN_HEIGHT = 844;

/** 확대 상한 — 큰 모니터에서 무한정 키우면 글자가 우스꽝스럽게 커진다. */
const MAX_SCALE = 1.6;

/** 축소 하한 — 이보다 작아지면 읽을 수 없다. 그 아래로는 잘리는 대신 스크롤을 허용한다. */
const MIN_SCALE = 0.45;

function computeScale(width: number, height: number): number {
  const fit = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit));
}

export function Stage({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(() =>
    computeScale(window.innerWidth, window.innerHeight),
  );

  useEffect(() => {
    // visualViewport가 있으면 그쪽을 본다 — 모바일에서 주소창이 접히고 펴질 때
    // innerHeight는 늦게 따라오지만 visualViewport는 즉시 반영된다.
    const vv = window.visualViewport;
    const measure = () =>
      setScale(computeScale(vv?.width ?? window.innerWidth, vv?.height ?? window.innerHeight));

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    vv?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      vv?.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div className={styles.viewport}>
      <div
        className={styles.stage}
        style={{
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
