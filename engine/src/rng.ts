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
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(seed);
    let mj = MSEED - subtraction;
    this.seedArray[55] = mj;
    let mk = 1;

    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.seedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.seedArray[ii];
    }

    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let v = this.seedArray[i] - this.seedArray[1 + ((i + 30) % 55)];
        if (v < 0) v += MBIG;
        this.seedArray[i] = v;
      }
    }
  }

  private internalSample(): number {
    let locINext = this.inext;
    let locINextp = this.inextp;

    if (++locINext >= 56) locINext = 1;
    if (++locINextp >= 56) locINextp = 1;

    let retVal = this.seedArray[locINext] - this.seedArray[locINextp];
    if (retVal === MBIG) retVal--;
    if (retVal < 0) retVal += MBIG;

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
}

/** 엔진이 받는 난수 인터페이스 — 테스트가 결정론 생성기를 주입할 수 있게 한다. */
export interface Rng {
  nextDouble(): number;
  next(maxValue: number): number;
}
