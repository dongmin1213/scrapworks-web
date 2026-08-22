/**
 * .NET `System.Random(seed)` 재현 — **골든 대조가 성립하려면 난수까지 같아야 한다.**
 *
 * 원본(Unity C#)은 `new System.Random(seed)`로 매물 상태·발견물을 굴린다. 여기서 다른
 * 난수를 쓰면 "같은 시드로 같은 결과"를 대조할 수 없고, 대조할 수 없으면 이식이 맞는지
 * 확인할 방법이 없다 — 소울 던전에서 Sfc32를 원작에 주입한 것과 같은 이유다.
 *
 * .NET의 **시드가 주어진** Random은 Knuth 감산식 지연 피보나치 생성기이며,
 * .NET 6에서 무시드 경로가 바뀐 뒤에도 **재현성을 위해 이 알고리즘이 그대로 유지된다.**
 * 그래서 이 구현은 미래 런타임에서도 원본과 일치한다.
 *
 * 32비트 정수 연산이라 자바스크립트의 배정밀도로 안전하게 표현된다(|값| < 2^31).
 */

const MBIG = 2147483647; // int.MaxValue
const MSEED = 161803398;

export class DotNetRandom {
  private readonly seedArray = new Int32Array(56);
  private inext = 0;
  private inextp = 21;

  constructor(seed: number) {
    // int.MinValue의 절댓값은 int 범위를 넘는다 — 원본과 같은 예외 처리를 그대로 옮긴다
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(seed | 0);

    // **`| 0`으로 32비트 wrap을 먼저 일으킨 뒤 음수 보정한다.**
    // C#은 unchecked int 연산이라 `MSEED - subtraction`이 int 범위를 넘으면 **먼저 wrap되고**
    // 그 다음에 `< 0` 보정이 걸린다. JS의 배정밀도로 계산한 뒤 Int32Array에 넣으면
    // 보정 순서가 뒤바뀌어 **큰 시드에서 값이 갈라졌다** — 실제 게임 시드는
    // `Math.random() * int.MaxValue`라 그 범위가 나온다(적대적 리뷰 R4에서 10억 이상 불일치 확인).
    let mj = (MSEED - subtraction) | 0;
    this.seedArray[55] = mj;
    let mk = 1;

    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.seedArray[ii] = mk;
      mk = (mj - mk) | 0;
      if (mk < 0) mk = (mk + MBIG) | 0;
      mj = this.seedArray[ii];
    }

    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let v = (this.seedArray[i] - this.seedArray[1 + ((i + 30) % 55)]) | 0;
        if (v < 0) v = (v + MBIG) | 0;
        this.seedArray[i] = v;
      }
    }
  }

  private internalSample(): number {
    let locINext = this.inext;
    let locINextp = this.inextp;

    if (++locINext >= 56) locINext = 1;
    if (++locINextp >= 56) locINextp = 1;

    // 여기도 같은 이유로 32비트 wrap을 먼저 일으킨다 (위 생성자 주석)
    let retVal = (this.seedArray[locINext] - this.seedArray[locINextp]) | 0;
    if (retVal === MBIG) retVal--;
    if (retVal < 0) retVal = (retVal + MBIG) | 0;

    this.seedArray[locINext] = retVal;
    this.inext = locINext;
    this.inextp = locINextp;
    return retVal;
  }

  /** `Random.NextDouble()` — [0, 1) */
  nextDouble(): number {
    return this.internalSample() * (1.0 / MBIG);
  }

  /** `Random.Next(maxValue)` — [0, maxValue) */
  next(maxValue: number): number {
    if (maxValue < 0) throw new RangeError("maxValue must be >= 0");
    return Math.floor(this.nextDouble() * maxValue);
  }

  /**
   * 내부 상태를 통째로 꺼낸다 — **세이브가 난수까지 이어 붙이기 위해서.**
   *
   * 저장할 때 시드만 적으면 새로고침이 수열을 처음으로 되돌린다. 그러면 발견물이 나올
   * 자리를 기억했다가 저장 직전에 새로고침하는 것으로 **원하는 결과를 반복해서 뽑을 수
   * 있다**(scumming). 상태를 그대로 이어 붙이면 그 경로가 막힌다.
   */
  saveState(): RngState {
    return { s: Array.from(this.seedArray), i: this.inext, p: this.inextp };
  }

  static restore(state: RngState): DotNetRandom {
    const r = new DotNetRandom(0);
    r.seedArray.set(state.s);
    r.inext = state.i;
    r.inextp = state.p;
    return r;
  }

  /** 저장된 상태가 이 구현이 쓸 수 있는 모양인가 — 손상된 세이브를 조용히 받지 않는다. */
  static isValidState(v: unknown): v is RngState {
    if (typeof v !== "object" || v === null) return false;
    const s = v as Partial<RngState>;
    return (
      Array.isArray(s.s) &&
      s.s.length === 56 &&
      s.s.every((n) => Number.isInteger(n)) &&
      Number.isInteger(s.i) &&
      Number.isInteger(s.p)
    );
  }
}

/** 직렬화된 난수 상태 — `seedArray` 56칸 + 두 커서. */
export interface RngState {
  s: number[];
  i: number;
  p: number;
}

/** 엔진이 받는 난수 인터페이스 — 테스트가 결정론 생성기를 주입할 수 있게 한다. */
export interface Rng {
  nextDouble(): number;
  next(maxValue: number): number;
}
