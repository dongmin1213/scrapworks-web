import type { Balance } from "./balance";
import type { Workshop } from "./workshop";
import type { YardLine } from "./yardLine";

/**
 * 세션 루프 — 원본 `GameMain.Update`에 대응한다.
 *
 * **순서가 규칙이다**: 원작은 `Line.Tick(dt)` 다음에 `AutoBuy()`를 부른다.
 * 순서를 뒤집으면 같은 프레임에 산 물건이 곧바로 처리되기 시작해 진행이 한 틱 빨라지고,
 * 자동매입이 소비하는 난수 위치도 달라진다.
 *
 * **왜 화면(useGame)이 아니라 엔진에 두는가**: 자동매입은 노드로 해금되는 **규칙**이지
 * 화면 편의가 아니다. 화면에 두면 골든이 덮을 수 없고, 실제로 그래서
 * `autoBuyUnlocked`가 이식돼 있는데 **소비처가 없어 노드를 사도 아무 일도 일어나지
 * 않았다**(적대적 리뷰 R5). 규칙은 엔진이 소유하고 골든이 대조한다.
 */
export class Session {
  constructor(
    private readonly balance: Balance,
    private readonly workshop: Workshop,
    private readonly line: YardLine,
  ) {}

  /** 한 프레임 — 원작 `GameMain.Update`의 게임 로직 부분 그대로. */
  tick(dt: number): void {
    this.line.tick(dt);
    this.autoBuy();
  }

  /**
   * 자동 매입 — 원작 `GameMain.AutoBuy`.
   *
   * 대기열이 **비었을 때만** 감당 가능한 최고 등급부터 훑는다. 미개봉(hidden)은
   * 건너뛴다 — 판단이 필요한 선택은 유저 몫으로 남기고 안전한 기본만 자동화한다는
   * 원작의 선이다.
   *
   * **등급마다 상태를 굴린다** (사지 못해도). 원작이 그렇게 하므로 난수 소비도 같다.
   */
  private autoBuy(): void {
    if (!this.workshop.autoBuyUnlocked || this.line.queue.length > 0) return;
    for (let g = this.line.maxBuyableGrade; g >= 1; g--) {
      const cond = this.line.rollCondition();
      if (this.balance.condition(cond).hidden) continue; // 미개봉은 자동으로 사지 않는다
      if (this.line.canBuy(g, cond)) {
        this.line.buy(g, cond);
        return;
      }
    }
  }
}
