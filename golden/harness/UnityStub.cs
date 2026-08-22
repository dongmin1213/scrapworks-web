// Unity 의존성 stub — **원작 클래스를 고치지 않고 그대로 컴파일하기 위한 최소 대체물.**
//
// `YardLine.cs`·`Workshop.cs`는 UnityEngine을 전혀 쓰지 않는다(순수 C#).
// `Balance.cs`만 `Resources.Load<TextAsset>`와 `JsonUtility.FromJson`을 쓰므로 그 둘만 흉내낸다.
//
// **왜 이렇게까지 하는가**: 수식을 골든 스크립트에 다시 옮겨 적으면 **같은 전사 실수가
// 양쪽에 들어가 전부 통과한다.** 실제로 그렇게 만든 골든 101건이 매물 재고·난수 순서
// 결함을 하나도 잡지 못했다(적대적 리뷰 R4). 원작 코드를 그대로 돌려야 대조가 성립한다.
using System;
using System.IO;
using System.Text.Json;

namespace UnityEngine
{
    public sealed class TextAsset
    {
        public string text;
        public TextAsset(string t) { text = t; }
    }

    public static class Resources
    {
        /// 원작이 `Resources/balance.json`을 읽는 자리 — **원본 레포의 파일**을 그대로 준다.
        public static T Load<T>(string name) where T : class
        {
            if (typeof(T) != typeof(TextAsset)) return null;
            var path = Environment.GetEnvironmentVariable("SCRAP_BALANCE_PATH")
                       ?? Path.Combine("..", "..", "..", "scrapworks", "unity", "Assets", "Resources", name + ".json");
            if (!File.Exists(path)) throw new FileNotFoundException($"balance를 찾을 수 없다: {Path.GetFullPath(path)}");
            return new TextAsset(File.ReadAllText(path)) as T;
        }
    }

    /// JsonUtility 대체. 원작 Balance·SaveData는 [Serializable] 공개 **필드**만 쓰므로 필드 바인딩으로 충분하다.
    public static class JsonUtility
    {
        static readonly JsonSerializerOptions Opts = new JsonSerializerOptions
        {
            IncludeFields = true,
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };

        public static T FromJson<T>(string json) => JsonSerializer.Deserialize<T>(json, Opts);
        public static string ToJson(object o) => JsonSerializer.Serialize(o, Opts);
    }

    /// 세이브 경로 — 하네스는 임시 폴더에 쓴다(원작 동작을 건드리지 않는다).
    public static class Application
    {
        public static string persistentDataPath =>
            Environment.GetEnvironmentVariable("SCRAP_SAVE_DIR") ?? Path.GetTempPath();
    }

    public static class Debug
    {
        public static void Log(object o) { }
        public static void LogWarning(object o) { }
        public static void LogError(object o) { }
    }

    public static class Mathf
    {
        public static float Clamp(float v, float lo, float hi) => Math.Min(hi, Math.Max(lo, v));
        public static float Max(float a, float b) => Math.Max(a, b);
        public static float Min(float a, float b) => Math.Min(a, b);
    }

    /// 시간 — **하네스가 dt를 직접 정한다.** 원작 Clock이 `Time.deltaTime`을 읽으므로,
    /// 여기에 고정 스텝을 넣으면 원작 틱 루프를 결정론적으로 돌릴 수 있다.
    public static class Time
    {
        public static float deltaTime = 1f / 60f;
        public static float unscaledDeltaTime = 1f / 60f;
        public static float time = 0f;
        public static float realtimeSinceStartup = 0f;
    }

    public static class PlayerPrefs
    {
        public static int GetInt(string k, int d) => d;
        public static void SetInt(string k, int v) { }
        public static void Save() { }
    }
}
