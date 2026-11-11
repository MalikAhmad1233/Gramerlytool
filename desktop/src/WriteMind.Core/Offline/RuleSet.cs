using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace WriteMind.Core.Offline;

/// <summary>One rule from shared/offline/rules.json (the Chrome extension interprets the same file).</summary>
public sealed record RuleDef
{
    public required string Id { get; init; }
    public required string Category { get; init; }
    public required string Severity { get; init; }
    public required string Title { get; init; }
    public required string Message { get; init; }
    public required string Pattern { get; init; }
    public string Flags { get; init; } = "";
    public int Group { get; init; }
    public IReadOnlyList<string>? Replace { get; init; }
    public string? Template { get; init; }
    public string? Map { get; init; }
    public int? MapGroup { get; init; }
    public string? UnlessPrecededBy { get; init; }
    public string? ReverseIfFollowedBy { get; init; }
    public IReadOnlyList<string>? Exceptions { get; init; }
    public int? ExceptGroup { get; init; }
    public bool SkipAllCaps { get; init; }
    public bool SkipInCasual { get; init; }
    public IReadOnlyList<string>? Styles { get; init; }
    public double Confidence { get; init; }
}

public sealed record RewriteData
{
    public required IReadOnlyList<IReadOnlyList<string>> FormalPhrases { get; init; }
    public required IReadOnlyList<IReadOnlyList<string>> CasualPhrases { get; init; }
    public required IReadOnlyList<IReadOnlyList<string>> ConcisePhrases { get; init; }
    public required IReadOnlyList<IReadOnlyList<string>> Contract { get; init; }
    public required string FillersProfessional { get; init; }
    public required string FillersConcise { get; init; }
    public required string QuestionStart { get; init; }
}

public sealed record RuleData
{
    public required IReadOnlyList<string> ChatApps { get; init; }
    public required IReadOnlyList<string> Protect { get; init; }
    public required IReadOnlyList<string> AllowWords { get; init; }
    public required IReadOnlyDictionary<string, string> Typos { get; init; }
    public required IReadOnlyDictionary<string, IReadOnlyDictionary<string, JsonElement>> Maps { get; init; }
    public required IReadOnlyList<RuleDef> Rules { get; init; }
    public required RewriteData Rewrite { get; init; }

    public IReadOnlyList<string> MapValues(string map, string key)
    {
        if (!Maps.TryGetValue(map, out var entries) || !entries.TryGetValue(key, out var value)) return [];
        return value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray().Select(v => v.GetString() ?? "").ToList()
            : [value.GetString() ?? ""];
    }
}

/// <summary>An issue in UTF-16 offsets (.NET string indices).</summary>
public sealed record OfflineIssue(
    int Start,
    int End,
    string Original,
    IReadOnlyList<string> Replacements,
    string Category,
    string Severity,
    string Title,
    string Message,
    string RuleId,
    double Confidence,
    bool FromRule);

public static partial class RuleSet
{
    private static readonly Lazy<RuleData> LazyData = new(Load);
    private static readonly Lazy<List<Compiled>> LazyCompiled = new(Compile);
    private static readonly Lazy<IReadOnlyList<Regex>> LazyProtect = new(() =>
        Data.Protect.Select(p => new Regex(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToList());

    public static RuleData Data => LazyData.Value;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    private sealed record Compiled(RuleDef Def, Regex Re, Regex? Preceded, Regex? Followed);

    private static RuleData Load()
    {
        using var stream = typeof(RuleSet).Assembly.GetManifestResourceStream("WriteMind.Core.Offline.rules.json")
            ?? throw new InvalidOperationException("Embedded rules.json is missing.");
        return JsonSerializer.Deserialize<RuleData>(stream, JsonOptions) ?? throw new InvalidOperationException("Invalid rules.json.");
    }

    private static RegexOptions OptionsFor(string flags) =>
        RegexOptions.CultureInvariant | (flags.Contains('i', StringComparison.Ordinal) ? RegexOptions.IgnoreCase : RegexOptions.None);

    private static List<Compiled> Compile() => Data.Rules.Select(def => new Compiled(
        def,
        new Regex(def.Pattern, OptionsFor(def.Flags)),
        def.UnlessPrecededBy is null ? null : new Regex(def.UnlessPrecededBy, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant),
        def.ReverseIfFollowedBy is null ? null : new Regex(def.ReverseIfFollowedBy, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)))
        .ToList();

    public static string MatchCase(string source, string replacement)
    {
        if (source.Length == 0 || replacement.Length == 0) return replacement;
        var first = source[0];
        var r0 = replacement[0];
        if (char.IsUpper(first) && char.IsLower(r0)) return char.ToUpperInvariant(r0) + replacement[1..];
        return replacement;
    }

    [GeneratedRegex(@"\{(=|\^?\d)\}")]
    private static partial Regex TemplateToken();

    private static string Fill(string template, Match m, string mapped) =>
        TemplateToken().Replace(template, t =>
        {
            var token = t.Groups[1].Value;
            if (token == "=") return mapped;
            if (token[0] == '^')
            {
                var g = m.Groups[int.Parse(token[1..], System.Globalization.CultureInfo.InvariantCulture)];
                var v = g.Success ? g.Value : "";
                return v.Length == 0 ? v : char.ToUpperInvariant(v[0]) + v[1..];
            }
            var group = m.Groups[int.Parse(token, System.Globalization.CultureInfo.InvariantCulture)];
            return group.Success ? group.Value : "";
        });

    public static List<OfflineIssue> RuleIssues(string text, string style, bool casual)
    {
        var issues = new List<OfflineIssue>();
        foreach (var (def, re, preceded, followed) in LazyCompiled.Value)
        {
            if (def.Styles is not null && !def.Styles.Contains(style)) continue;
            if (def.SkipInCasual && casual) continue;
            foreach (Match m in re.Matches(text))
            {
                var group = m.Groups[def.Group];
                if (!group.Success || group.Length == 0) continue;
                var target = group.Value;
                if (def.SkipAllCaps && target.Length > 1 && !target.Any(char.IsLower)) continue;
                if (def.Exceptions is not null)
                {
                    var except = m.Groups[def.ExceptGroup ?? def.Group];
                    if (def.Exceptions.Contains((except.Success ? except.Value : "").ToLowerInvariant())) continue;
                }
                if (preceded is not null && preceded.IsMatch(text[Math.Max(0, m.Index - 40)..m.Index])) continue;

                List<string> replacements;
                if (def.Map is not null)
                {
                    var keyGroup = m.Groups[def.MapGroup ?? def.Group];
                    var key = (keyGroup.Success ? keyGroup.Value : "").ToLowerInvariant().Replace('’', '\'');
                    var values = Data.MapValues(def.Map, key);
                    if (values.Count == 0) continue;
                    replacements = def.Template is null ? [.. values] : values.Select(v => Fill(def.Template, m, v)).ToList();
                    if (followed is not null && followed.IsMatch(text[(group.Index + group.Length)..])) replacements.Reverse();
                }
                else if (def.Replace is not null)
                {
                    replacements = def.Replace.Select(t => Fill(t, m, "")).ToList();
                }
                else
                {
                    replacements = [Fill(def.Template ?? "", m, "")];
                }
                replacements = replacements.Select(r => MatchCase(target, r)).Where(r => r != target).ToList();
                if (replacements.Count == 0) continue;
                issues.Add(new OfflineIssue(group.Index, group.Index + group.Length, target, replacements, def.Category, def.Severity,
                    def.Title, Fill(def.Message, m, replacements[0]), def.Id, def.Confidence, FromRule: true));
            }
        }
        return issues;
    }

    public static List<(int Start, int End)> ProtectedSpans(string text)
    {
        var spans = new List<(int, int)>();
        foreach (var re in LazyProtect.Value)
        {
            foreach (Match m in re.Matches(text))
            {
                if (m.Length > 0) spans.Add((m.Index, m.Index + m.Length));
            }
        }
        return spans;
    }

    public static bool OverlapsAny(int start, int end, List<(int Start, int End)> spans)
    {
        var e = Math.Max(end, start + 1);
        return spans.Any(s => start < s.End && s.Start < e);
    }
}
