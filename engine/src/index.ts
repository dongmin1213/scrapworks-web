/**
 * 헤드리스 엔진 공개 표면 — 화면은 이 타입들만 안다.
 *
 * 원본(Unity)의 규칙을 그대로 옮긴 순수 TS다. DOM·React·타이머에 의존하지 않으므로
 * 골든 테스트가 브라우저 없이 규칙을 대조할 수 있다 (소울 던전과 같은 구조).
 */
export { Balance } from "./balance";
export type {
  BalanceData,
  NodeDef,
  OperatorDef,
  SkillCfg,
  ShopCfg,
  ToolCfg,
  SpecialCost,
  StartCfg,
  ConditionDef,
  FindItem,
  LineCfg,
  MachineCfg,
  AxisCfg,
  SpecialCfg,
} from "./balance";
export { DotNetRandom } from "./rng";
export type { Rng, RngState } from "./rng";
export { Session } from "./session";
export { shouldYieldSave, nextRevision, canWriteSave } from "./saveLease";
export type { SaveOwnership } from "./saveLease";
export { Workshop, newGame, sanitizeSave, SAVE_VERSION } from "./workshop";
export type { SaveData } from "./workshop";
export { YardLine } from "./yardLine";
export type { Axis, BuyOffer, Item, YardEvents, YardState } from "./yardLine";
