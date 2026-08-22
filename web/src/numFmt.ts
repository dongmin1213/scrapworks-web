/**
 * 거대 수치 포맷 — 원본 `NumFmt.F`의 1:1 이식.
 * 규약: double + K/M/B/T 단위 (BigInteger 금지 — 등급 곡선이 double 정밀도 안에서 끝난다).
 */
const UNITS = ["", "K", "M", "B", "T", "Q"];

export const NumFmt = {
  f(v: number): string {
    if (v < 0) return "-" + NumFmt.f(-v);
    if (v < 1000) {
      // 10 미만의 소수만 소수점 한 자리 — 원본과 같은 규칙
      if (v < 10 && v !== Math.floor(v)) return trimZeros(v.toFixed(1));
      return String(Math.floor(v));
    }
    let u = 0;
    while (v >= 1000 && u < UNITS.length - 1) {
      v /= 1000;
      u++;
    }
    const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
    return trimZeros(v.toFixed(digits)) + UNITS[u];
  },

  /** 초 → 시·분 분해 (원본 HoursMinutes) */
  hoursMinutes(seconds: number): { h: number; m: number } {
    return { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) };
  },
};

/** C#의 "0.##"는 뒤따르는 0을 지운다 — toFixed는 남기므로 맞춰 준다 */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
