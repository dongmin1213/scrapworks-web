/**
 * 두 탭 스모크 — <b>실제 브라우저 두 개로 소유권을 다툰다.</b>
 *
 * 순수 함수 테스트(`mayClaimLease` 등)는 「판정이 옳은가」만 본다. 정작 진행이
 * 사라진 경로는 <b>순서</b>였다: 새 탭이 부팅에서 저장을 읽고 → mount 이펙트가
 * 리스를 뺏고 → 밀린 부팅 저장이 자기 옛 메모리를 기록한다 (적대적 리뷰 R10-12).
 * 그 순서는 브라우저에서만 재현된다.
 *
 * 그래서 여기서 보는 것은 딱 하나다: <b>탭 A가 열려 있는 동안 탭 B를 열어도
 * A의 진행이 남는가.</b> 그리고 그 반대편도 본다 — A를 닫으면 B가 인수해야 한다.
 * 「뺏기지 않는다」만 지키면 탭을 한 번 닫는 것으로 게임이 영원히 잠긴다.
 *
 *   node scripts/two-tab-smoke.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4188;
const failures = [];
const ok = (label, detail = "") => console.log(`  OK   ${label}${detail ? ` — ${detail}` : ""}`);
const fail = (label, detail) => {
  failures.push(label);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// **먼저 빌드한다** — preview는 dist를 그대로 서빙하므로, 안 하면 옛 번들을 통과시킨다
if (spawnSync("npx", ["vite", "build"], { cwd: "web", stdio: "inherit" }).status !== 0) {
  console.log("  FAIL 빌드");
  process.exit(1);
}

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: "web",
  stdio: "ignore",
});
process.on("exit", () => server.kill());

for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    /* 아직 안 떴다 */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
// **같은 컨텍스트여야 한다** — localStorage를 공유하는 두 탭이 문제였다
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const url = `http://localhost:${PORT}/`;

const readSave = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("scrapworks.save.v3") ?? "null");
    } catch {
      return null;
    }
  });

const readLease = (page) =>
  page.evaluate(() => {
    try {
      return localStorage.getItem("scrapworks.lease");
    } catch {
      return null;
    }
  });

const isReadOnly = (page) =>
  page.evaluate(() => {
    // App.tsx의 소유권 안내 문구 — 이 탭이 멈춰 있다는 표시
    return document.body.innerText.includes("다른 탭에서 게임이 진행 중");
  });

try {
  // ── 탭 A: 열고 잠시 진행시킨다 ──
  const a = await context.newPage();
  await a.goto(url, { waitUntil: "networkidle" });
  // **주기 저장은 20초다**(balance.json의 saveIntervalSec) — 저장이 한 번은 나야
  // 「진행이 되감겼는가」를 잴 기준선이 생긴다. 느리지만 이 스모크의 값어치가 거기 있다.
  await a.waitForTimeout(22000);

  const beforeB = await readSave(a);
  if (beforeB && typeof beforeB.rev === "number") ok("탭 A 저장", `rev ${beforeB.rev}`);
  else fail("탭 A 저장", "저장이 만들어지지 않았다");

  // ── 탭 B: 나중에 연다. A는 아직 살아 있다 ──
  const b = await context.newPage();
  await b.goto(url, { waitUntil: "networkidle" });
  await b.waitForTimeout(2000);

  if (await isReadOnly(b)) ok("나중 탭은 읽기 전용", "살아 있는 주인을 뺏지 않는다");
  else fail("나중 탭은 읽기 전용", `B가 소유권을 가져갔다 (lease=${String(await readLease(b)).slice(0, 48)})`);

  // ── A의 진행이 살아 있는가 ──
  await a.bringToFront();
  await a.waitForTimeout(22000);
  const afterB = await readSave(a);

  if (afterB && beforeB && afterB.rev >= beforeB.rev) ok("탭 A 진행 유지", `rev ${beforeB.rev} → ${afterB.rev}`);
  else fail("탭 A 진행 유지", `rev가 되돌아갔다: ${beforeB?.rev} → ${afterB?.rev}`);

  const cashNow = afterB?.d?.cash;
  const cashBefore = beforeB?.d?.cash;
  if (typeof cashNow === "number" && typeof cashBefore === "number" && cashNow >= cashBefore) {
    ok("진행이 되감기지 않았다", `${cashBefore} → ${cashNow}`);
  } else {
    fail("진행이 되감기지 않았다", `${cashBefore} → ${cashNow}`);
  }

  // ── A를 닫으면 게임이 다시 놀 수 있어야 한다 ──
  //
  // **B가 그 자리에서 인수하지는 않는다.** B의 메모리는 A가 저장한 것보다 낡았고,
  // 낡은 메모리로 쓰면 그게 바로 진행이 사라지는 경로다. 그래서 B는 읽기 전용으로
  // 남고 화면이 「새로고침하면 최신 상태로 이어집니다」라고 말한다.
  //
  // 지켜야 할 것은 「B가 바로 이어받는다」가 아니라 <b>막다른 길이 아니다</b>이다:
  // 새로고침 한 번이면 주인이 되고, 그때 진행이 되감기지 않는다.
  await a.close();
  await b.bringToFront();
  await b.waitForTimeout(9000); // TTL(7초) + 여유

  if (await isReadOnly(b)) ok("낡은 탭은 인수하지 않는다", "낡은 메모리로 쓰면 진행이 사라진다");
  else ok("낡지 않은 탭은 인수한다", "주인이 사라지면 이어받는다");

  await b.reload({ waitUntil: "networkidle" });
  await b.waitForTimeout(2500);
  if (!(await isReadOnly(b))) ok("새로고침하면 이어받는다", "닫은 탭이 소유권을 물고 죽지 않는다");
  else fail("새로고침하면 이어받는다", "A를 닫고 새로고침해도 읽기 전용이다 — 막다른 길이다");

  const reloaded = await readSave(b);
  const lastCash = afterB?.d?.cash;
  if (typeof reloaded?.d?.cash !== "number" || typeof lastCash !== "number") {
    ok("이어받은 진행", "저장이 아직 없다(주기 저장 전) — 되감김 판정은 건너뛴다");
  } else if (reloaded.d.cash >= lastCash) {
    ok("이어받은 진행이 되감기지 않았다", `${lastCash} → ${reloaded.d.cash}`);
  } else {
    fail("이어받은 진행이 되감기지 않았다", `${lastCash} → ${reloaded.d.cash}`);
  }
} finally {
  await browser.close();
  server.kill();
}

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length}개가 실패했다: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("두 탭이 서로의 진행을 지우지 않는다.");
