import { Stage } from "./Stage";
import styles from "./App.module.css";
import { NumFmt } from "./numFmt";
import { t } from "./strings";
import { useGame } from "./useGame";

/**
 * 스크랩웍스 웹판.
 *
 * 원본(Unity 모바일 세로)의 **규칙은 엔진이 1:1로 갖고 있고**(골든 81건이 대조한다),
 * 이 파일은 그 상태를 보여주고 입력을 전달하는 일만 한다.
 *
 * 화면 구성은 원본의 세로 흐름을 따른다:
 *   상단 자원 → 작업대(현재 물건·진행) → 축 전환 → 대기열 → 매입
 * 위에서 아래로 "돈이 물건이 되고 물건이 다시 돈이 되는" 순환이 한 화면에 보여야 한다.
 */
export function App() {
  const { state, buy, setMode, claimFind } = useGame();
  const current = state.queue[0];

  return (
    <Stage>
      <div className={styles.screen}>
        {/* ── 자원 ── */}
        <header className={styles.resources}>
          <div className={styles.cash}>
            <span className={styles.cashLabel}>{t("cur.cash")}</span>
            <strong className={styles.cashValue}>{NumFmt.f(state.cash)}</strong>
          </div>
          <div className={styles.subResources}>
            <Res label={t("cur.scrap")} value={state.scrap} icon={asset("sprites/part-frame.png")} />
            <Res label={t("cur.parts")} value={state.parts} icon={asset("sprites/part-wiring.png")} />
            <Res label={t("cur.copper")} value={state.copper} icon={asset("sprites/part-shell.png")} />
            <Res label={t("cur.boards")} value={state.boards} icon={asset("sprites/part-board.png")} />
          </div>
        </header>

        {/* ── 작업대 ── */}
        <section className={styles.bench} aria-label="작업대">
          {current ? (
            <>
              <div className={styles.machineWrap}>
                <img
                  className={styles.machine}
                  src={machineSprite(current.grade)}
                  alt={machineName(current.grade)}
                  style={{ opacity: state.conveyorT < 1 ? 0.45 : 1 }}
                />
                <div className={styles.machineMeta}>
                  <span className={styles.machineName}>{machineName(current.grade)}</span>
                  <span className={styles.condition}>
                    {current.revealed ? conditionName(current.conditionId) : t("cond.sealedDesc")}
                  </span>
                </div>
              </div>

              <div className={styles.hpTrack} role="progressbar" aria-valuenow={Math.round(state.progress * 100)}>
                <div className={styles.hpFill} style={{ width: `${state.progress * 100}%` }} />
              </div>
              <span className={styles.eta}>
                {state.conveyorT < 1 ? "반입 중" : `${Math.ceil(state.secondsLeft)}초`}
              </span>
            </>
          ) : (
            <p className={styles.idle}>작업대가 비었습니다 — 아래에서 매입하세요</p>
          )}
        </section>

        {/* ── 축 전환 — 이 게임의 코어 판단 ── */}
        <section className={styles.axis} aria-label="처리 방식">
          <button
            type="button"
            className={styles.axisButton}
            data-active={state.mode === "smash" || undefined}
            onClick={() => setMode("smash")}
          >
            <span className={styles.axisName}>{t("run.smash")}</span>
            {/* 축 힌트는 원본 Loc에 없다 — 두 축의 차이가 이 게임의 코어 판단이라
                화면에서 반드시 설명돼야 한다. 수치가 아니라 성격을 말한다. */}
            <span className={styles.axisHint}>빠르다 · 고철이 많다</span>
          </button>
          <button
            type="button"
            className={styles.axisButton}
            data-active={state.mode === "strip" || undefined}
            onClick={() => setMode("strip")}
          >
            <span className={styles.axisName}>{t("run.strip")}</span>
            <span className={styles.axisHint}>느리다 · 부품과 발견물</span>
          </button>
        </section>

        {/* ── 대기열 — 압박은 타이머가 아니라 여기서 나온다 ── */}
        <section className={styles.queue} aria-label="대기열">
          {Array.from({ length: state.queueSlots }, (_, i) => {
            const item = state.queue[i];
            return (
              <div key={i} className={styles.slot} data-filled={item ? true : undefined}>
                {item ? (
                  <>
                    <img src={machineSprite(item.grade)} alt="" className={styles.slotIcon} />
                    <span className={styles.slotGrade}>{item.grade}</span>
                  </>
                ) : (
                  <span className={styles.slotEmpty}>+</span>
                )}
              </div>
            );
          })}
        </section>

        {/* ── 매입 ── */}
        <section className={styles.buy} aria-label="매입">
          {state.buyable.map((b) => (
            <button
              key={b.grade}
              type="button"
              className={styles.buyButton}
              disabled={!b.affordable}
              onClick={() => buy(b.grade)}
            >
              <span className={styles.buyName}>{machineName(b.grade)}</span>
              <span className={styles.buyPrice}>{NumFmt.f(b.price)}</span>
            </button>
          ))}
        </section>

        {/* ── 발견물 — 탭해서 수령 ── */}
        {state.pendingPickup && (
          <button type="button" className={styles.find} onClick={claimFind}>
            <span className={styles.findTitle}>{t("find.title")}</span>
            {/* 발견물 이름 키는 원본이 `find.find-cash` 형태다 — 접두사를 떼지 않는다 */}
            <span className={styles.findName}>{t(`find.${state.pendingPickup}`)}</span>
            <span className={styles.findCash}>+{NumFmt.f(state.pendingPickupCash)}</span>
          </button>
        )}
      </div>
    </Stage>
  );
}

function Res({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className={styles.res}>
      <img src={icon} alt="" className={styles.resIcon} />
      <span className={styles.resLabel}>{label}</span>
      <span className={styles.resValue}>{NumFmt.f(value)}</span>
    </div>
  );
}

/**
 * 자산 경로 — **`import.meta.env.BASE_URL`을 반드시 붙인다.**
 * 게임은 `/g/<slug>/` 하위에서 서빙되므로 `/sprites/...`처럼 루트 절대 경로를 쓰면
 * 포털 루트를 가리켜 404가 난다 (실제로 그렇게 스프라이트 4개가 깨졌다).
 */
function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

/**
 * 등급별 스프라이트 — **원본에 있는 3종만 실물이고 그 위는 재사용한다.**
 * 없는 것을 있는 척 그리지 않는다: 4등급 이상은 3등급 이미지를 쓰고 이름으로 구분한다.
 * (원본도 등급 4~10 전용 에셋은 "다음 할 일"에 남아 있다)
 */
function machineSprite(grade: number): string {
  const n = Math.min(3, grade);
  return asset(`sprites/mach-${n}.png`);
}

function machineName(grade: number): string {
  return grade <= 10 ? t(`mach.${grade}`) : t("mach.high").replace("{0}", String(grade));
}

function conditionName(id: string): string {
  return t(`cond.${id.replace("cond-", "")}`);
}
