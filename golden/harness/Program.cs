// 골든 픽스처 생성기 — **원작 C# 클래스를 그대로 실행한다.**
//
// 이전 버전(DumpFixtures.csx)은 원작의 수식을 골든 스크립트에 **다시 옮겨 적었다.**
// 그러면 같은 전사 실수가 양쪽에 들어가 101건이 전부 통과한다 — 실제로 매물 재고와
// 난수 호출 순서 결함을 하나도 잡지 못했다(적대적 리뷰 R4). 대조가 성립하려면
// 한쪽은 **원본 그 자체**여야 한다. 그래서 여기서는 Balance/YardLine/Workshop을
// 링크로 컴파일해 **호출만** 한다.
//
// 이 파일이 지키는 선: **게임 수식을 여기에 적지 않는다.** 정산·발견 확률처럼 수식이
// private 메서드 안에 있으면, 그 값을 다시 계산하지 않고 **실제 객체를 그 상태로 몰아넣어
// 원작 코드가 계산하게 한 뒤 결과만 읽는다.**
//
// 실행: dotnet run --project golden/harness -- <출력경로>
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using Scrap;

static class Program
{
    static readonly JsonSerializerOptions Out = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    static int Main(string[] argv)
    {
        var dest = argv.Length > 0 ? argv[0] : "../fixtures/core.json";
        var B = Balance.Get();

        var doc = new Dictionary<string, object>
        {
            ["source"] = "원작 C# 클래스 직접 실행 (golden/harness/Program.cs) — 수식 전사 없음",
            ["generatedBy"] = "Balance.cs · YardLine.cs · Workshop.cs · SaveSystem.cs · Clock.cs · Loc.cs (scrapworks 원본을 링크 컴파일)",
            ["formulas"] = Formulas(B),
            ["rngCases"] = RngCases(),
            ["conditionRolls"] = ConditionRolls(),
            ["settlements"] = Settlements(B),
            ["findChances"] = FindChances(B),
            ["progression"] = Progression(B),
            ["scenarios"] = Scenarios(),
        };

        var full = Path.GetFullPath(dest);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, JsonSerializer.Serialize(doc, Out));
        Console.WriteLine($"픽스처 기록: {full}");
        return 0;
    }

    // ── 등급별 기본 수치 — Balance의 public 메서드를 그대로 호출 ──
    static object Formulas(Balance B)
    {
        var rows = new List<object>();
        for (int g = 1; g <= B.machine.gradeCap; g++)
            rows.Add(new
            {
                grade = g,
                buyPrice = B.BuyPrice(g),
                durability = B.Durability(g),
                yieldTotal = B.YieldTotal(g),
                copper = B.SpecialQty(B.special.copperBase, g),
                boards = B.SpecialQty(B.special.boardsBase, g),
                cores = B.SpecialQty(B.special.coresBase, g),
            });
        return rows;
    }

    // ── .NET System.Random 재현 대조 ──
    // 큰 시드에서 unchecked int 랩이 **음수 보정보다 먼저** 일어나야 한다 — TS 포팅이 틀리기 쉬운 자리.
    static object RngCases()
    {
        int[] seeds = { 1, 2, 7, 42, 123, 999, 2147483647, -2147483648, 1_000_000_000, 1_500_000_000, 2_000_000_000 };
        var rows = new List<object>();
        foreach (var s in seeds)
        {
            var r = new Random(s);
            var doubles = new List<double>();
            for (int i = 0; i < 10; i++) doubles.Add(r.NextDouble());
            var r2 = new Random(s);
            var ints = new List<int>();
            for (int i = 0; i < 10; i++) ints.Add(r2.Next(100));
            rows.Add(new { seed = s, doubles, ints });
        }
        return rows;
    }

    // ── 상태 굴림 — **원작 YardLine.RollCondition을 그대로 호출** ──
    static object ConditionRolls()
    {
        int[] seeds = { 1, 42, 777, 20250101 };
        var rows = new List<object>();
        foreach (var s in seeds)
        {
            var line = new YardLine(new Workshop(null), s);
            _ = new Offers(line);   // 이식본 생성자와 같은 지점에서 매대 6칸을 굴린다
            var rolled = new List<string>();
            for (int i = 0; i < 40; i++) rolled.Add(line.RollCondition());
            rows.Add(new { seed = s, rolled });
        }
        return rows;
    }

    // ── 정산 스윕 — **원작 CompleteInner가 계산하게 하고 결과만 읽는다** ──
    //
    // 수식은 private이라 밖에서 부를 수 없다. 그래서 실제 Item을 목표 stripFrac 상태로
    // 몰아넣고 Hp를 0으로 만들어 원작이 스스로 정산하게 한 뒤, 자원 증가분을 기록한다.
    // 여기에 수식을 다시 적지 않는 것이 이 하네스의 존재 이유다.
    static object Settlements(Balance B)
    {
        var rows = new List<object>();
        foreach (var c in B.conditions)
            for (int g = 1; g <= Math.Min(3, B.machine.gradeCap); g++)
                foreach (var frac in new[] { 0.0, 0.5, 1.0 })
                {
                    var (w, line, it) = Rig(g, c.id, maxGrade: B.machine.gradeCap);

                    it.FindRolled = true;      // 발견 난수를 배제해 정산만 관측한다
                    it.TotalDmg = it.MaxHp;
                    it.SmashDmg = it.MaxHp * (1 - frac);
                    it.Hp = 0;

                    double c0 = w.Cash, s0 = w.Scrap, p0 = w.Parts;
                    double cu0 = w.Copper, bo0 = w.Boards, co0 = w.Cores;
                    int gr0 = w.D.maxGrade;

                    line.Tick(1f / 30f);       // Hp<=0 → 원작 Complete → CompleteInner

                    rows.Add(new
                    {
                        grade = g,
                        condition = c.id,
                        stripFrac = frac,
                        scrapGain = R(w.Scrap - s0),
                        partsGain = R(w.Parts - p0),
                        cashGain = R(w.Cash - c0),
                        copperGain = R(w.Copper - cu0),
                        boardsGain = R(w.Boards - bo0),
                        coresGain = R(w.Cores - co0),
                        totalMachines = w.D.totalMachines,
                        maxGradeAfter = w.D.maxGrade,
                        unlocked = w.D.maxGrade > gr0,
                    });
                }
        return rows;
    }

    // ── 발견 확률 — **원작 RollFind를 몬테카를로로 재는 대신, 경계 시드를 이분 탐색한다** ──
    //
    // RollFind는 `rng.NextDouble() >= chance`로 판정한다. 같은 상태에서 여러 시드를 돌려
    // "발견이 난 비율"을 기록하면 확률값 자체를 전사하지 않고도 확률을 고정할 수 있다.
    // 시드 목록이 고정이라 결과는 완전히 결정론적이다.
    static object FindChances(Balance B)
    {
        const int TRIALS = 400;
        var rows = new List<object>();
        foreach (var c in B.conditions)
            for (int g = 1; g <= Math.Min(3, B.machine.gradeCap); g++)
                foreach (var frac in new[] { 0.0, 1.0 })
                {
                    int hits = 0;
                    var byItem = new SortedDictionary<string, int>();
                    for (int seed = 1; seed <= TRIALS; seed++)
                    {
                        var (w, line, it) = Rig(g, c.id, maxGrade: B.machine.gradeCap, seed: seed);
                        it.TotalDmg = it.MaxHp;
                        it.SmashDmg = it.MaxHp * (1 - frac);
                        it.Hp = 0;

                        string found = null;
                        line.OnFind += id => found = id;
                        line.Tick(1f / 30f);   // TotalDmg >= MaxHp*0.5 → RollFind 실행

                        if (found != null)
                        {
                            hits++;
                            byItem.TryGetValue(found, out var n);
                            byItem[found] = n + 1;
                        }
                    }
                    rows.Add(new { grade = g, condition = c.id, stripFrac = frac, trials = TRIALS, hits, byItem });
                }
        return rows;
    }

    // ── 성장 곡선 — 노드/도구/작업자/인증 비용 (전부 public 메서드) ──
    static object Progression(Balance B)
    {
        var nodes = new List<object>();
        foreach (var n in B.skill.nodes)
        {
            var costs = new List<double>();
            for (int lv = 0; lv < Math.Min(n.max, 12); lv++) costs.Add(B.NodeCost(n, lv));
            nodes.Add(new { id = n.id, stat = n.stat, per = n.per, max = n.max, costs });
        }

        var tools = new List<object>();
        for (int t = 2; t <= B.tool.tierCount; t++) tools.Add(new { tier = t, cost = B.ToolCost(t) });

        var ops = new List<object>();
        for (int r = 2; r <= B.shop.operators.Length; r++) ops.Add(new { rank = r, cost = B.OperatorCost(r) });

        var certs = new List<object>();
        foreach (var cum in new double[] { 0, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9 })
            certs.Add(new { cumScrap = cum, certs = B.CertsFrom(cum), mult = B.CertMult(B.CertsFrom(cum)) });

        return new { nodes, tools, operators = ops, certs };
    }

    // ── 시나리오 — **여기가 진짜 방어선.** ──
    //
    // 매입 → 컨베이어 → 혼합 처리(smash/strip 전환) → 조수 → 발견물 → 정산 → 해금을
    // 한 줄기로 돌리고, 매 초의 관측 가능한 전체 상태를 기록한다. 개별 수식이 맞아도
    // **호출 순서**나 **난수 소비 횟수**가 어긋나면 여기서 갈라진다 — 단위 픽스처가
    // 절대 잡지 못하는 종류의 결함이다(매물 재고 누락이 정확히 그랬다).
    static object Scenarios() => new List<object>
    {
        RunScenario("basic-smash", seed: 1, seconds: 120, toggleEverySec: 0, startCash: 5_000, buyGrade: 1),
        RunScenario("mixed-mode", seed: 42, seconds: 180, toggleEverySec: 7, startCash: 20_000, buyGrade: 1),
        RunScenario("helper-lane", seed: 777, seconds: 240, toggleEverySec: 11, startCash: 500_000, buyGrade: 2, unlockHelper: true),
        RunScenario("high-grade", seed: 20250101, seconds: 300, toggleEverySec: 5, startCash: 5_000_000, buyGrade: 3, unlockHelper: true, maxGrade: 4),
    };

    static object RunScenario(
        string name, int seed, int seconds, int toggleEverySec, double startCash,
        int buyGrade, bool unlockHelper = false, int maxGrade = 2)
    {
        var B = Balance.Get();
        var w = new Workshop(null);
        w.D.maxGrade = maxGrade;
        w.EarnCash(startCash);
        if (unlockHelper)
            foreach (var n in B.skill.nodes)
                if (n.stat == "helper") { w.D.nodeIds.Add(n.id); w.D.nodeLevels.Add(1); break; }

        var line = new YardLine(w, seed);
        var offers = new Offers(line);   // 원작 BuyUI.Build — 여기서 6회 굴린다
        var events = new List<object>();
        line.OnFind += id => events.Add(new { t = "find", id });
        line.OnItemDone += it => events.Add(new { t = "done", grade = it.Grade, cond = it.ConditionId });

        const float DT = 1f / 30f;   // 30Hz 고정 스텝 — 결정론
        UnityEngine.Time.deltaTime = DT;

        var trace = new List<object>();
        int steps = (int)Math.Round(seconds / DT);
        int togglePeriod = toggleEverySec > 0 ? (int)Math.Round(toggleEverySec / DT) : 0;

        for (int i = 0; i < steps; i++)
        {
            // **매 스텝 매대의 그 등급을 눌러 본다** — 실패하면 난수를 쓰지 않고,
            // 성공하면 그 행만 다시 굴린다. 이식본이 이 규칙을 어기면(누를 때마다 굴리면)
            // 이후 발견물 난수가 전부 한 칸씩 밀려 여기서 갈라진다.
            if (offers.Buy(buyGrade)) events.Add(new { t = "buy", grade = buyGrade });

            if (togglePeriod > 0 && i > 0 && i % togglePeriod == 0) line.ToggleMode();

            line.Tick(DT);
            if (line.PendingPickup != null) line.ClaimFind();

            if (i % 30 == 0) trace.Add(Snapshot(i * DT, w, line));
        }

        return new
        {
            name, seed, seconds, toggleEverySec, buyGrade, maxGrade, unlockHelper, startCash, dt = DT,
            final = new
            {
                cash = R(w.Cash), scrap = R(w.Scrap), parts = R(w.Parts),
                copper = R(w.Copper), boards = R(w.Boards), cores = R(w.Cores),
                cumScrap = R(w.D.cumScrap), lifetimeCash = R(w.D.lifetimeCash),
                codexIds = w.D.codexIds, findCount = w.D.findCount,
                totalMachines = w.D.totalMachines, maxGrade = w.D.maxGrade,
                queue = line.Queue.Count, mode = line.Mode.ToString(),
            },
            eventCount = events.Count,
            events,
            trace,
        };
    }

    static object Snapshot(double sec, Workshop w, YardLine line) => new
    {
        sec = R(sec),
        cash = R(w.Cash), scrap = R(w.Scrap), parts = R(w.Parts),
        copper = R(w.Copper), boards = R(w.Boards), cores = R(w.Cores),
        cumScrap = R(w.D.cumScrap), lifetimeCash = R(w.D.lifetimeCash),
        queue = line.Queue.Count,
        conveyorT = R((double)line.ConveyorT),
        mode = line.Mode.ToString(),
        working = line.Working,
        hp = NR(line.Current?.Hp),
        maxHp = NR(line.Current?.MaxHp),
        totalDmg = NR(line.Current?.TotalDmg),
        smashDmg = NR(line.Current?.SmashDmg),
        revealed = line.Current?.Revealed,
        helperHp = NR(line.Helper?.Hp),
        codex = w.CodexCount,
        finds = w.D.findCount,
        maxGrade = w.D.maxGrade,
        totalMachines = w.D.totalMachines,
    };

    // ── 매대(BuyUI) 재현 ──
    //
    // 원작에서 매물 재고를 소유하는 것은 YardLine이 아니라 **BuyUI**다:
    // `Build()`가 등급 1~6을 **여섯 번 굴려** 각 행에 고정하고, `OnBuy`가 **성공했을 때만**
    // 그 행을 다시 굴린다. 이식본은 이걸 엔진(YardLine.offers)으로 옮겼으므로,
    // 하네스도 같은 난수 소비 패턴을 재현해야 두 스트림이 정렬된다.
    // 여기를 빼먹으면 골든이 "우연히 다른 값"을 정답으로 굳혀 버린다.
    const int OfferRows = 6;

    sealed class Offers
    {
        readonly YardLine line;
        public readonly string[] Cond = new string[OfferRows + 1];   // 1-base

        public Offers(YardLine l)
        {
            line = l;
            for (int g = 1; g <= OfferRows; g++) Cond[g] = line.RollCondition();
        }

        /// BuyUI.OnBuy — 성공 시에만 그 행을 다시 굴린다.
        public bool Buy(int grade)
        {
            if (grade < 1 || grade > OfferRows) return false;
            if (!line.Buy(grade, Cond[grade])) return false;
            Cond[grade] = line.RollCondition();
            return true;
        }
    }

    /// 정산·발견 관측용 리그 — 물건 하나를 작업대에 올려 컨베이어까지 끝낸 상태로 만든다.
    static (Workshop, YardLine, YardLine.Item) Rig(int grade, string condId, int maxGrade, int seed = 1)
    {
        var w = new Workshop(null);
        w.D.maxGrade = maxGrade;
        w.EarnCash(1e12);                     // 매입가 제약을 없앤다 (정산 관측이 목적)
        var line = new YardLine(w, seed);
        _ = new Offers(line);                 // 이식본 생성자와 같은 지점에서 6회 소비
        if (!line.Buy(grade, condId)) throw new InvalidOperationException($"매입 실패: g{grade} {condId}");

        // 컨베이어를 끝까지 돌린다 — 도착해야 해체/정산 경로에 들어간다
        for (int i = 0; i < 10_000 && !line.Working; i++) line.Tick(1f / 30f);
        if (!line.Working) throw new InvalidOperationException("컨베이어가 끝나지 않았다");
        return (w, line, line.Current);
    }

    /// 부동소수 꼬리 자르기 — 언어 간 마지막 비트 차이로 골든이 깨지지 않게.
    /// 9자리면 실제 결함(순서·횟수 어긋남)은 남기고 ULP 잡음만 없앤다.
    static double R(double v) => Math.Round(v, 9);
    static double? NR(double? v) => v is null ? null : Math.Round(v.Value, 9);
}
