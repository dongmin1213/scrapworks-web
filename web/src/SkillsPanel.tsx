import type { NodeDef } from "@scrapworks/engine";
import styles from "./Panel.module.css";
import { NumFmt } from "./numFmt";
import { t } from "./strings";

/**
 * 스킬 트리 — 원작 `SkillsUI`.
 *
 * **고철이 성장 통화다.** 현금은 매물을 사는 돈이고, 고철은 여기서만 쓴다 —
 * 그 분리가 원작 v2의 핵심이라 화면에서도 두 통화를 섞어 보여주지 않는다.
 *
 * 노드는 `stat`이 아니라 원작의 세 그룹(본인·작업장·산출)으로 묶인다.
 * 그룹은 id 접두사가 정한다 (`body-`/`yard-`/`yield-`) — 원작 SkillsUI와 같은 규칙.
 */
const GROUPS: { prefix: string; label: string }[] = [
  { prefix: "body-", label: t("skill.body") },
  { prefix: "yard-", label: t("skill.yard") },
  { prefix: "yield-", label: t("skill.yield") },
];

export interface NodeRow {
  def: NodeDef;
  level: number;
  cost: number;
  maxed: boolean;
  affordable: boolean;
}

/**
 * 노드 효과 한 줄 — 원작 `SkillsUI.RefreshRow` 그대로.
 *
 * **가산 스탯은 원값, 비율 스탯은 %로** 보여준다. `queueAdd`·`autoBuy`·`helper`는
 * 개수·해금이라 비율이 아니고, 그래서 `Flat` 접미사가 없어도 원값 쪽에 들어간다.
 * 문장 뒤의 " / Lv"도 원작이 붙인다 — 한 레벨당 얼마인지를 말한다.
 */
function describeNode(def: NodeDef): string {
  const flat =
    def.stat.endsWith("Flat") ||
    def.stat === "queueAdd" ||
    def.stat === "autoBuy" ||
    def.stat === "helper";
  const effVal = flat ? def.per : Math.round(def.per * 100 * 10) / 10;
  return `${t(`node.desc.${def.id}`).replace("{0}", String(effVal))} / Lv`;
}

export function SkillsPanel({
  scrap,
  rows,
  onBuy,
}: {
  scrap: number;
  rows: NodeRow[];
  onBuy: (id: string) => void;
}) {
  return (
    <div className={styles.panel}>
      <p className={styles.currency}>
        {t("cur.scrap")} <strong>{NumFmt.f(scrap)}</strong>
      </p>

      {GROUPS.map((group) => {
        const inGroup = rows.filter((r) => r.def.id.startsWith(group.prefix));
        if (inGroup.length === 0) return null;
        return (
          <section key={group.prefix} className={styles.group}>
            <h2 className={styles.groupTitle}>{group.label}</h2>
            {inGroup.map((row) => (
              <button
                key={row.def.id}
                type="button"
                className={styles.row}
                disabled={row.maxed || !row.affordable}
                onClick={() => onBuy(row.def.id)}
              >
                <span className={styles.rowMain}>
                  <span className={styles.rowName}>{t(`node.${row.def.id}`)}</span>
                  <span className={styles.rowDesc}>{describeNode(row.def)}</span>
                </span>
                <span className={styles.rowSide}>
                  <span className={styles.rowLevel}>
                    {row.maxed
                      ? t("node.max")
                      : t("node.lv").replace("{0}", String(row.level)).replace("{1}", String(row.def.max))}
                  </span>
                  {/* 만렙이면 가격을 지운다 — 살 수 없는 것에 값을 붙이면 왜 안 눌리는지 헷갈린다 */}
                  {!row.maxed && <span className={styles.rowCost}>{NumFmt.f(row.cost)}</span>}
                </span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}
