import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 원작 소스 계약 — **하네스가 재현한 규칙이 원작과 아직 같은가.**
 *
 * 골든 하네스는 원작의 `Balance`·`YardLine`·`Workshop`을 링크로 **직접 컴파일**한다.
 * 하지만 `BuyUI`(매대)와 `GameMain`(틱 순서·자동매입)은 그럴 수 없다 — MonoBehaviour이고
 * Unity UI에 얽혀 있다. 그래서 그 둘만 하네스가 **재현**한다.
 *
 * 재현은 복사본이고, 복사본은 갈라진다. codex의 지적이 정확히 그것이었다:
 * "원작 BuyUI의 행 수나 재롤 순서를 바꿔도 하네스는 자동으로 바뀌지 않는다."
 *
 * 여기서는 원작 소스를 **읽어서** 재현이 기대는 성질이 아직 그대로인지 확인한다.
 * 원작이 바뀌면 이 테스트가 먼저 깨져서 하네스를 고칠 신호를 준다.
 *
 * **원작 레포가 없으면 건너뛴다** — CI나 남의 기계에서는 형제 폴더가 없을 수 있고,
 * 그때 빨간불을 내면 아무도 신뢰하지 않는 테스트가 된다. 대신 건너뛴 사실을 남긴다.
 */

const ORIGIN = fileURLToPath(new URL("../../../scrapworks/unity/Assets/Scripts/", import.meta.url));

function source(relative: string): string | null {
  const path = ORIGIN + relative;
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** 주석을 지운다 — 주석 안의 문장이 규칙인 것처럼 잡히면 안 된다. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const buyUi = source("Workshop/BuyUI.cs");
const gameMain = source("Shared/GameMain.cs");
const available = buyUi !== null && gameMain !== null;

describe.skipIf(!available)("원작 BuyUI — 하네스의 매대 재현이 기대는 성질", () => {
  it("등급 1~6을 훑어 행을 만든다 (하네스 OfferRows=6의 근거)", () => {
    expect(stripComments(buyUi!)).toMatch(/for\s*\(\s*int\s+g\s*=\s*1\s*;\s*g\s*<=\s*6\s*;\s*g\+\+\s*\)/);
  });

  it("행을 만들 때 상태를 한 번 굴린다", () => {
    expect(stripComments(buyUi!)).toMatch(/new\s+Row\s*\{[^}]*ConditionId\s*=\s*L\.RollCondition\(\)/s);
  });

  it("**구매에 성공했을 때만** 그 행을 다시 굴린다", () => {
    const code = stripComments(buyUi!);
    // `if (L.Buy(...)) { ... r.ConditionId = L.RollCondition(); ... }`
    const onBuy = code.slice(code.indexOf("void OnBuy"));
    const guard = onBuy.match(/if\s*\(\s*L\.Buy\([^)]*\)\s*\)\s*\{([\s\S]*?)\n\s{8}\}/);
    expect(guard, "OnBuy의 성공 분기를 찾지 못했다 — 원작 구조가 바뀌었다").not.toBeNull();
    expect(guard![1]).toContain("RollCondition()");
    // 성공 분기 **밖에서** 굴리면 실패해도 난수가 소비된다 — 그건 다른 규칙이다
    const outside = onBuy.replace(guard![0], "");
    expect(outside, "성공 분기 밖에서 상태를 굴린다 — 하네스 재현과 다르다").not.toContain(
      "RollCondition()",
    );
  });
});

describe.skipIf(!available)("원작 GameMain — 하네스의 틱 순서·자동매입 재현이 기대는 성질", () => {
  it("Tick 다음에 AutoBuy를 부른다 (순서가 규칙이다)", () => {
    const code = stripComments(gameMain!);
    const tickAt = code.indexOf("Line.Tick(");
    const autoAt = code.indexOf("AutoBuy()");
    expect(tickAt, "Line.Tick 호출을 찾지 못했다").toBeGreaterThan(-1);
    expect(autoAt, "AutoBuy 호출을 찾지 못했다").toBeGreaterThan(-1);
    expect(autoAt, "AutoBuy가 Tick보다 먼저 온다 — 순서가 바뀌었다").toBeGreaterThan(tickAt);
  });

  it("자동매입은 대기열이 비었을 때만, 해금됐을 때만 돈다", () => {
    const code = stripComments(gameMain!);
    const body = code.slice(code.indexOf("void AutoBuy"));
    expect(body).toMatch(/if\s*\(\s*!\s*Workshop\.AutoBuyUnlocked\s*\|\|\s*Line\.Queue\.Count\s*>\s*0\s*\)\s*return/);
  });

  it("최고 등급부터 내려오며 미개봉은 건너뛴다", () => {
    const body = stripComments(gameMain!).slice(stripComments(gameMain!).indexOf("void AutoBuy"));
    expect(body).toMatch(/for\s*\(\s*int\s+g\s*=\s*Line\.MaxBuyableGrade\s*;\s*g\s*>=\s*1\s*;\s*g--\s*\)/);
    expect(body).toMatch(/Condition\(cond\)\.hidden\s*\)\s*continue/);
  });

  it("등급마다 상태를 굴린다 — 사지 못해도 난수를 쓴다", () => {
    const body = stripComments(gameMain!).slice(stripComments(gameMain!).indexOf("void AutoBuy"));
    // RollCondition이 for 안, CanBuy 검사보다 앞에 있어야 한다
    const roll = body.indexOf("RollCondition()");
    const canBuy = body.indexOf("CanBuy(");
    expect(roll).toBeGreaterThan(-1);
    expect(canBuy).toBeGreaterThan(roll);
  });
});

describe("원작 레포 접근성", () => {
  it("원작을 찾지 못하면 그 사실을 남긴다", () => {
    if (!available) {
      // 실패시키지 않는다 — 다만 조용히 넘어가지도 않는다.
      console.warn(
        `[원작 소스 계약] ${ORIGIN} 를 찾지 못해 건너뛰었다. ` +
          "하네스의 BuyUI·GameMain 재현이 원작과 같은지 확인되지 않았다.",
      );
    }
    expect(true).toBe(true);
  });
});
