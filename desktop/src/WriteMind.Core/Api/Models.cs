using System.Text.Json;
using System.Text.Json.Serialization;

namespace WriteMind.Core.Api;

/// <summary>
/// WriteMind API contract (mirrors backend/app/schemas; see shared/openapi.json).
/// All offsets and lengths are UTF-16 code units — the same unit .NET strings use.
/// Enum-like values are kept as strings so newer servers never break older clients.
/// </summary>
public static class Categories
{
    public const string Grammar = "grammar";
    public const string Spelling = "spelling";
    public const string Punctuation = "punctuation";
    public const string Style = "style";
    public const string Clarity = "clarity";
    public static readonly IReadOnlyList<string> All = [Grammar, Spelling, Punctuation, Style, Clarity];
}

public static class Styles
{
    public static readonly IReadOnlyList<string> Check = ["neutral", "professional", "casual", "formal"];
    public static readonly IReadOnlyList<string> Rewrite = ["professional", "formal", "casual", "friendly", "concise"];
}

public sealed record Suggestion
{
    public required string Id { get; init; }
    public required string Fingerprint { get; init; }
    public required int Offset { get; init; }
    public required int Length { get; init; }
    public required string Original { get; init; }
    public required IReadOnlyList<string> Replacements { get; init; }
    public required string Category { get; init; }
    public required string Severity { get; init; }
    public required string Title { get; init; }
    public required string Message { get; init; }
    public required string RuleId { get; init; }
    public required string Source { get; init; }
    public double Confidence { get; init; }

    [JsonIgnore] public int End => Offset + Length;
}

public sealed record ClientContext(string Kind, string? App);

public sealed record CheckRequest
{
    public required string Text { get; init; }
    public string Language { get; init; } = "en-US";
    public string Style { get; init; } = "neutral";
    public string Mode { get; init; } = "fast";
    public ClientContext Client { get; init; } = new("windows-desktop", null);
    public IReadOnlyList<string>? Categories { get; init; }
    public IReadOnlyList<string> Dictionary { get; init; } = [];
    public IReadOnlyList<string> DisabledRules { get; init; } = [];
    public bool Ai { get; init; } = true;
}

public sealed record CheckStats(int Characters, int Words, int Sentences, IReadOnlyDictionary<string, int> Issues, int Score);

public sealed record EngineInfo(string Languagetool, string Ai, int ParagraphsChecked, int ParagraphsCached, double LatencyMs);

public sealed record CheckResponse(
    string TextHash,
    string Language,
    string Style,
    string Mode,
    IReadOnlyList<Suggestion> Suggestions,
    CheckStats Stats,
    EngineInfo Engine);

public sealed record RewriteRequest
{
    public required string Text { get; init; }
    public string Style { get; init; } = "professional";
    public int Count { get; init; } = 3;
    public string Language { get; init; } = "en-US";
    public ClientContext Client { get; init; } = new("windows-desktop", null);
    public bool Ai { get; init; } = true;
}

public sealed record RewriteAlternative(string Text, string Source, bool MeaningPreserved, IReadOnlyList<string> Notes);

public sealed record RewriteResponse(string Style, IReadOnlyList<RewriteAlternative> Alternatives, string Engine, double LatencyMs);

public sealed record UserInfo(Guid Id, string Email, string? DisplayName, string Plan, DateTimeOffset CreatedAt);

public sealed record TokenPair(string AccessToken, string RefreshToken, string TokenType, int ExpiresIn, UserInfo User);

public sealed record RemoteSettings(
    string Language,
    string DefaultStyle,
    bool AiEnabled,
    IReadOnlyList<string> EnabledCategories,
    IReadOnlyList<string> DisabledRules,
    IReadOnlyList<string> DisabledSites,
    IReadOnlyList<string> DisabledApps);

public sealed record DictionaryResponse(IReadOnlyList<string> Words, int Count, int Limit);

public sealed record FeedbackEvent(string RuleId, string Category, string Source, string Action);

public sealed record UsageTotals(int Checks, long Characters, int SuggestionsShown, int Accepted, int Ignored, int Rewrites);

public sealed record UsageSummary(int Days, UsageTotals? Totals, double? AcceptanceRate);

public sealed record MetaInfo(string Name, string Version, bool AiAvailable, string Offsets);

internal sealed record ErrorEnvelope(ErrorBody? Error);

internal sealed record ErrorBody(string Code, string Message, string? RequestId);

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DictionaryKeyPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
