using System.Globalization;
using System.Text.RegularExpressions;
using WriteMind.Core.Api;

namespace WriteMind.Core.Offline;

public sealed record OfflineOptions(string Language, string Style, string? App, string Mode = "fast", IReadOnlyList<string>? Dictionary = null);

/// <summary>
/// WriteMind built-in checker: works with no server. Same rules and dictionaries as the Chrome extension,
/// same response shape as the API, UTF-16 offsets.
/// </summary>
public static partial class OfflineEngine
{
    private static readonly string[] ConsonantSoundPrefixes = ["uni", "use", "usu", "uti", "ure", "uro", "eu", "ewe", "one", "once", "ufo", "uk"];
    private static readonly string[] VowelSoundUni = ["unin", "unim", "unid"];
    private static readonly string[] SilentH = ["hour", "honest", "honor", "honour", "heir"];
    private static readonly HashSet<string> NotANoun = ["and", "or", "nor", "but", "is", "are", "was", "of", "to", "in", "on", "at", "the", "a", "an"];

    public static string Fnv1a(string text)
    {
        var h = 0x811c9dc5u;
        foreach (var c in text)
        {
            h ^= c;
            h = unchecked(h * 0x01000193u);
        }
        return h.ToString("x8", CultureInfo.InvariantCulture);
    }

    private static bool StartsWithVowelSound(string word)
    {
        if (word.Length > 1 && !word.Any(char.IsLower)) return "AEFHILMNORSX".Contains(word[0], StringComparison.Ordinal);
        var w = word.ToLowerInvariant();
        if (SilentH.Any(p => w.StartsWith(p, StringComparison.Ordinal))) return true;
        if (VowelSoundUni.Any(p => w.StartsWith(p, StringComparison.Ordinal))) return true;
        if (ConsonantSoundPrefixes.Any(p => w.StartsWith(p, StringComparison.Ordinal))) return false;
        return "aeiou".Contains(w[0], StringComparison.Ordinal);
    }

    [GeneratedRegex(@"\b(a|an|A|An)\s+([A-Za-z][A-Za-z'’-]*)")]
    private static partial Regex ArticleRegex();

    [GeneratedRegex(@"[\s""'“(]+$")]
    private static partial Regex TrailingOpeners();

    [GeneratedRegex(@"\n\s*$")]
    private static partial Regex EndsWithNewline();

    private static List<OfflineIssue> ArticleIssues(string text)
    {
        var issues = new List<OfflineIssue>();
        var re = ArticleRegex();
        var m = re.Match(text);
        while (m.Success)
        {
            var article = m.Groups[1].Value;
            var next = m.Groups[2].Value;
            var nextStart = m.Index + article.Length;
            var skip = NotANoun.Contains(next.ToLowerInvariant());
            if (!skip && article[0] == 'A')
            {
                var before = TrailingOpeners().Replace(text[..m.Index], "");
                if (before.Length > 0 && before[^1] is not ('.' or '!' or '?') && !EndsWithNewline().IsMatch(text[..m.Index])) skip = true;
            }
            if (!skip)
            {
                var expected = StartsWithVowelSound(next) ? "an" : "a";
                if (!article.Equals(expected, StringComparison.OrdinalIgnoreCase))
                {
                    issues.Add(new OfflineIssue(m.Index, m.Index + article.Length, article, [RuleSet.MatchCase(article, expected)], "grammar",
                        "error", "Article",
                        expected == "an"
                            ? $"Use “an” before words that start with a vowel sound: “an {next}”."
                            : $"Use “a” before words that start with a consonant sound: “a {next}”.",
                        "WM_A_AN", 0.9, FromRule: true));
                }
            }
            m = re.Match(text, nextStart);
        }
        return issues;
    }

    private static List<OfflineIssue> ResolveOverlaps(List<OfflineIssue> issues)
    {
        static double Priority(OfflineIssue i) => i.Confidence + (i.FromRule ? 0.05 : 0);
        var kept = new List<OfflineIssue>();
        foreach (var issue in issues.OrderByDescending(Priority).ThenBy(i => i.Start))
        {
            var e = Math.Max(issue.End, issue.Start + 1);
            if (kept.Any(k => issue.Start < Math.Max(k.End, k.Start + 1) && k.Start < e)) continue;
            kept.Add(issue);
        }
        return kept.OrderBy(i => i.Start).ToList();
    }

    public static bool IsCasual(string style, string? app) =>
        style is not ("professional" or "formal") && (style == "casual" || (app is not null && RuleSet.Data.ChatApps.Contains(app)));

    public static List<OfflineIssue> FindIssues(string text, OfflineOptions options, Speller? speller)
    {
        if (!options.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(text)) return [];
        var protectedSpans = RuleSet.ProtectedSpans(text);
        var dictionary = (options.Dictionary ?? []).Select(w => w.ToLowerInvariant()).ToHashSet();
        var all = RuleSet.RuleIssues(text, options.Style, IsCasual(options.Style, options.App))
            .Concat(ArticleIssues(text))
            .Concat(speller?.Issues(text, dictionary) ?? [])
            .Where(i => !RuleSet.OverlapsAny(i.Start, i.End, protectedSpans))
            .ToList();
        return ResolveOverlaps(all);
    }

    [GeneratedRegex(@"[\p{L}\p{N}'’-]+")]
    private static partial Regex Word();

    [GeneratedRegex(@"(?<=[.!?])\s+|\n+")]
    private static partial Regex SentenceSplit();

    public static CheckResponse Check(string text, OfflineOptions options, Speller? speller)
    {
        var started = DateTime.UtcNow;
        var issues = FindIssues(text, options, speller);
        var suggestions = issues.Select(i => new Suggestion
        {
            Id = "o_" + Fnv1a($"{i.RuleId}|{i.Start}|{i.Original}|{(i.Replacements.Count > 0 ? i.Replacements[0] : "")}"),
            Fingerprint = Fnv1a($"{i.RuleId}|{i.Original}|{text[Math.Max(0, i.Start - 12)..i.Start]}|{text[i.End..Math.Min(text.Length, i.End + 12)]}") + Fnv1a(i.Original),
            Offset = i.Start,
            Length = i.End - i.Start,
            Original = i.Original,
            Replacements = i.Replacements,
            Category = i.Category,
            Severity = i.Severity,
            Title = i.Title,
            Message = i.Message,
            RuleId = i.RuleId,
            Source = "writemind",
            Confidence = i.Confidence,
        }).ToList();
        var words = Word().Count(text);
        var byCategory = Categories.All.ToDictionary(c => c, _ => 0);
        double weighted = 0;
        foreach (var s in suggestions)
        {
            byCategory[s.Category]++;
            weighted += s.Severity switch { "error" => 4, "warning" => 2, _ => 1 };
        }
        var per100 = weighted * 100 / Math.Max(words, 50);
        var score = words == 0 ? 100 : (int)Math.Clamp(Math.Round(100 * Math.Exp(-per100 / 30), MidpointRounding.AwayFromZero), 0, 100);
        var sentences = SentenceSplit().Split(text).Count(s => s.Any(char.IsLetterOrDigit));
        return new CheckResponse(Fnv1a(text), options.Language, options.Style, options.Mode, suggestions,
            new CheckStats(text.Length, words, sentences, byCategory, score),
            new EngineInfo("builtin", "unavailable", 1, 0, (DateTime.UtcNow - started).TotalMilliseconds));
    }
}
