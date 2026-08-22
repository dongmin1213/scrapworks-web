#!/usr/bin/env dotnet-script
// 골든 기준값 — **원본(Unity C#)의 수식과 난수를 직접 돌려** 픽스처를 만든다.
//
//   cd golden/csharp && dotnet script DumpFixtures.csx
//
// 원본 클래스를 그대로 참조하지 않고 **수식만 옮겨 적는 것은 의미가 없다** —
// 옮겨 적는 과정에서 틀리면 골든도 같이 틀린다. 그런데 Unity 클래스는 UnityEngine에
// 의존해서 스크립트로 바로 못 부른다. 그래서 다음 원칙으로 만든다:
//
//   1) 난수는 **.NET System.Random 그 자체**를 쓴다 (원본이 쓰는 바로 그 구현)
//   2) 수치는 **원본 balance.json을 그대로 읽는다** (옮겨 적지 않는다)
//   3) 수식은 원본 소스에서 복사하되, **한 줄씩 출처 주석을 단다**
//
// TS 쪽은 이 픽스처와 대조한다. 둘 중 하나가 틀리면 값이 갈라진다.

#nullable enable
#r "nuget: System.Text.Json, 8.0.4"

using System.Text.Json;
using System.Text.Json.Nodes;

var balancePath = Path.Combine("..", "..", "engine", "content", "balance.json");
var json = JsonNode.Parse(File.ReadAllText(balancePath))!;

double D(JsonNode? n) => n!.GetValue<double>();
int I(JsonNode? n) => n!.GetValue<int>();

var machine = json["machine"]!;
var special = json["special"]!;
var conditions = json["conditions"]!.AsArray();
var find = json["find"]!;
var findItems = find["items"]!.AsArray();

// ── 수식 (원본 Balance.cs 174~180행) ───────────────────────────────────────
double BuyPrice(int g) => D(machine["buyBase"]) * Math.Pow(D(machine["buyGrowth"]), g - 1);
double Durability(int g) => D(machine["durBase"]) * Math.Pow(D(machine["durGrowth"]), g - 1);
double YieldTotal(int g) => D(machine["yieldBase"]) * Math.Pow(D(machine["yieldGrowth"]), g - 1);
double SpecialQty(double b, int g) => b * Math.Pow(D(special["qtyGrowth"]), g - 1);

// ── 1. 수식 표 ─────────────────────────────────────────────────────────────
var formulas = new List<object>();
foreach (var g in new[] { 1, 2, 3, 5, 10, 20, 40, 60 })
{
    formulas.Add(new
    {
        grade = g,
        buyPrice = BuyPrice(g),
        durability = Durability(g),
        yieldTotal = YieldTotal(g),
        copper = SpecialQty(D(special["copperBase"]), g),
        boards = SpecialQty(D(special["boardsBase"]), g),
        cores = SpecialQty(D(special["coresBase"]), g),
    });
}

// ── 2. 난수 수열 — 이식본이 같은 순서로 같은 값을 내야 한다 ────────────────
var rngCases = new List<object>();
foreach (var seed in new[] { 1, 7, 42, 12345, 999983 })
{
    var r = new Random(seed);
    var doubles = new List<double>();
    var ints = new List<int>();
    for (int i = 0; i < 10; i++) doubles.Add(r.NextDouble());
    for (int i = 0; i < 10; i++) ints.Add(r.Next(100));
    rngCases.Add(new { seed, doubles, ints });
}

// ── 3. 상태 굴림 — RollCondition의 가중 선택 (원본 YardLine.cs 66~82행) ────
var conditionRolls = new List<object>();
foreach (var seed in new[] { 1, 7, 42, 12345 })
{
    var r = new Random(seed);
    var rolled = new List<string>();
    for (int i = 0; i < 20; i++)
    {
        int total = 0;
        foreach (var c in conditions) total += I(c!["weight"]);
        int x = r.Next(total);
        string picked = conditions[0]!["id"]!.GetValue<string>();
        foreach (var c in conditions)
        {
            x -= I(c!["weight"]);
            if (x < 0) { picked = c["id"]!.GetValue<string>(); break; }
        }
        rolled.Add(picked);
    }
    conditionRolls.Add(new { seed, rolled });
}

// ── 4. 해체 정산 — CompleteInner의 회수액 (원본 YardLine.cs 227~250행) ─────
var axis = json["axis"]!;
var settlements = new List<object>();
foreach (var g in new[] { 1, 3, 8 })
foreach (var condId in new[] { "cond-normal", "cond-flood", "cond-burnt", "cond-mint", "cond-sealed" })
foreach (var stripFrac in new[] { 0.0, 0.5, 1.0 })
{
    var cond = conditions.First(c => c!["id"]!.GetValue<string>() == condId)!;
    double scrapMult = D(axis["smashScrapMult"]) + (D(axis["stripScrapMult"]) - D(axis["smashScrapMult"])) * stripFrac;
    double partsMult = D(axis["smashPartsMult"]) + (D(axis["stripPartsMult"]) - D(axis["smashPartsMult"])) * stripFrac;
    double total = YieldTotal(g);
    double scrapVal = total * (1 - D(machine["partsShare"])) * scrapMult * D(cond["scrapMult"]);
    double partsVal = total * D(machine["partsShare"]) * partsMult * D(cond["partsMult"]);
    settlements.Add(new { grade = g, condition = condId, stripFrac, scrapVal, partsVal });
}

// ── 5. 발견 확률 — RollFind의 chance 계산 (원본 YardLine.cs 199~203행) ─────
var findChances = new List<object>();
foreach (var g in new[] { 1, 5, 15 })
foreach (var condId in new[] { "cond-normal", "cond-mint" })
foreach (var stripFrac in new[] { 0.0, 0.5, 1.0 })
{
    var cond = conditions.First(c => c!["id"]!.GetValue<string>() == condId)!;
    double axisMult = D(axis["smashFindMult"]) + (D(axis["stripFindMult"]) - D(axis["smashFindMult"])) * stripFrac;
    double chance = (D(find["baseChance"]) + D(find["gradeBonus"]) * (g - 1)) * axisMult * D(cond["findMult"]);
    findChances.Add(new { grade = g, condition = condId, stripFrac, chance });
}

var outPath = Path.Combine("..", "fixtures", "core.json");
Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
File.WriteAllText(outPath, JsonSerializer.Serialize(new
{
    source = "scrapworks 원본 수식 + .NET System.Random (golden/csharp/DumpFixtures.csx)",
    formulas,
    rngCases,
    conditionRolls,
    settlements,
    findChances,
}, new JsonSerializerOptions { WriteIndented = true }));

Console.WriteLine($"픽스처 생성: {outPath}");
Console.WriteLine($"  수식 {formulas.Count} · 난수 {rngCases.Count} · 상태굴림 {conditionRolls.Count} · 정산 {settlements.Count} · 발견확률 {findChances.Count}");
