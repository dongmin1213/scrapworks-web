import type { OperatorDef, SpecialCost } from "@scrapworks/engine";
import styles from "./Panel.module.css";
import { NumFmt } from "./numFmt";
import { t } from "./strings";

/**
 * 상점 — 원작 `ShopUI`. 공구 강화와 작업자 사다리, 그리고 공방 이전(환생).
 *
 * **부품이 여기 통화다.** 현금은 매물, 고철은 스킬, 부품은 상점 — 세 통화가 각자
 * 갈 곳이 하나씩이라 "무엇을 위해 무엇을 하는가"가 화면에서 바로 보인다.
 *
 * 작업자는 **순차 구매**다(사다리). 건너뛰고 살 수 없고, 산 단수 중에서 착용만 고른다 —
 * 원작 `BuyOp`가 `opRank++`만 하고 `Equip`이 `1..opRank`로 clamp하는 이유다.
 */
export interface ToolRow {
  smash: boolean;
  label: string;
  tier: number;
  tierCount: number;
  cost: number;
  special: SpecialCost;
  maxed: boolean;
  affordable: boolean;
}

export interface OpRow {
  rank: number;
  def: OperatorDef;
  owned: boolean;
  equipped: boolean;
}

export function ShopPanel(props: {
  parts: number;
  copper: number;
  boards: number;
  cores: number;
  tools: ToolRow[];
  ops: OpRow[];
  nextOpCost: number | null;
  canBuyOp: boolean;
  rebirth: { certs: number; pending: number; mult: number; can: boolean; armed: boolean };
  onBuyTool: (smash: boolean) => void;
  onBuyOp: () => void;
  onEquip: (rank: number) => void;
  onRebirth: () => void;
}) {
  return (
    <div className={styles.panel}>
      <p className={styles.currency}>
        {t("cur.parts")} <strong>{NumFmt.f(props.parts)}</strong>
      </p>

      {/* ── 공구 ── */}
      <section className={styles.group}>
        <h2 className={styles.groupTitle}>{t("shop.tools")}</h2>
        {props.tools.map((tool) => (
          <button
            key={tool.label}
            type="button"
            className={styles.row}
            disabled={tool.maxed || !tool.affordable}
            onClick={() => props.onBuyTool(tool.smash)}
          >
            <span className={styles.rowMain}>
              <span className={styles.rowName}>{tool.label}</span>
              <span className={styles.rowDesc}>
                {t("node.lv").replace("{0}", String(tool.tier)).replace("{1}", String(tool.tierCount))}
              </span>
            </span>
            <span className={styles.rowSide}>
              {tool.maxed ? (
                <span className={styles.rowLevel}>{t("node.max")}</span>
              ) : (
                <>
                  <span className={styles.rowCost}>{NumFmt.f(tool.cost)}</span>
                  {/* 특수 자원 요구는 **0이 아닐 때만** 보여준다 — 0을 나열하면 무엇이 부족한지 묻힌다 */}
                  <SpecialNeed need={tool.special} have={props} />
                </>
              )}
            </span>
          </button>
        ))}
      </section>

      {/* ── 작업자 ── */}
      <section className={styles.group}>
        <h2 className={styles.groupTitle}>{t("shop.operators")}</h2>
        {props.ops.map((op) => (
          <button
            key={op.def.id}
            type="button"
            className={styles.row}
            data-active={op.equipped || undefined}
            // 보유했으면 착용, 다음 단수면 고용, 그 위는 잠긴다 (사다리라 건너뛸 수 없다)
            disabled={op.equipped || (!op.owned && !(props.canBuyOp && isNextRank(op, props.ops)))}
            onClick={() => (op.owned ? props.onEquip(op.rank) : props.onBuyOp())}
          >
            <span className={styles.rowMain}>
              <span className={styles.rowName}>{t(`op.${op.def.id}`)}</span>
              <span className={styles.rowDesc}>{describeOperator(op.def)}</span>
            </span>
            <span className={styles.rowSide}>
              {op.equipped ? (
                <span className={styles.rowLevel}>{t("shop.equipped")}</span>
              ) : op.owned ? (
                <span className={styles.rowLevel}>{t("shop.equip")}</span>
              ) : isNextRank(op, props.ops) && props.nextOpCost !== null ? (
                <span className={styles.rowCost}>{NumFmt.f(props.nextOpCost)}</span>
              ) : (
                <span className={styles.rowLevel}>—</span>
              )}
            </span>
          </button>
        ))}
      </section>

      {/* ── 공방 이전(환생) ──
          되돌릴 수 없는 조작이라 **무엇이 사라지고 무엇이 남는지**를 먼저 적는다.
          그 문장도 원작 Loc이 소유한다(rebirth.desc). */}
      <section className={styles.group}>
        <h2 className={styles.groupTitle}>{t("rebirth.title")}</h2>
        <p className={styles.note}>{t("rebirth.desc")}</p>
        <p className={styles.note}>
          {t("rebirth.mult").replace("{0}", props.rebirth.mult.toFixed(2))}
          {" · "}
          {t("rebirth.pending").replace("{0}", String(props.rebirth.pending))}
        </p>
        {/* **두 번 눌러야 실행된다** (원작 3초 재확인). 첫 탭 뒤에는 문구가 바뀌어
            "다음 탭이 진짜"라는 것을 말한다 — 되돌릴 수 없는 조작이다. */}
        <button
          type="button"
          className={styles.rebirth}
          data-armed={props.rebirth.armed || undefined}
          disabled={!props.rebirth.can}
          onClick={props.onRebirth}
        >
          {props.rebirth.armed ? `! ${t("rebirth.go")} !` : t("rebirth.go")}
        </button>
        {props.rebirth.armed && <p className={styles.note}>한 번 더 누르면 실행됩니다 (3초)</p>}
      </section>
    </div>
  );
}

/** 사다리의 **다음 칸**인가 — 보유하지 않은 것 중 가장 낮은 단수 하나만 살 수 있다. */
function isNextRank(op: OpRow, all: OpRow[]): boolean {
  const nextUnowned = all.find((o) => !o.owned);
  return nextUnowned?.rank === op.rank;
}

/** 작업자 효과 한 줄 — 원작 Loc에 설명 문장이 없어 수치에서 만든다(0인 항목은 빼고). */
function describeOperator(def: OperatorDef): string {
  const parts: string[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (def.smashPct) parts.push(`부수기 +${pct(def.smashPct)}`);
  if (def.stripPct) parts.push(`뜯기 +${pct(def.stripPct)}`);
  if (def.allValPct) parts.push(`전 산출 +${pct(def.allValPct)}`);
  if (def.scrapValPct) parts.push(`고철 +${pct(def.scrapValPct)}`);
  if (def.partsValPct) parts.push(`부품 +${pct(def.partsValPct)}`);
  if (def.cashValPct) parts.push(`현금 +${pct(def.cashValPct)}`);
  if (def.findPct) parts.push(`발견 +${pct(def.findPct)}`);
  return parts.length > 0 ? parts.join(" · ") : "효과 없음";
}

/** 특수 자원 요구 — 부족한 것은 눈에 띄게. 무엇이 모자라 못 사는지가 보여야 한다. */
function SpecialNeed({
  need,
  have,
}: {
  need: SpecialCost;
  have: { copper: number; boards: number; cores: number };
}) {
  const items: { label: string; want: number; got: number }[] = [
    { label: t("cur.copper"), want: need.copper, got: have.copper },
    { label: t("cur.boards"), want: need.boards, got: have.boards },
    { label: t("cur.cores"), want: need.cores, got: have.cores },
  ].filter((x) => x.want > 0);

  if (items.length === 0) return null;
  return (
    <span className={styles.special}>
      {items.map((x) => (
        <span key={x.label} data-short={x.got < x.want || undefined}>
          {x.label} {NumFmt.f(x.want)}
        </span>
      ))}
    </span>
  );
}
