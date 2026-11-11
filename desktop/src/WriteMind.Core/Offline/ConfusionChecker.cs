using System.Text.Json;
using System.Text.RegularExpressions;

namespace WriteMind.Core.Offline;

/// <summary>
/// Confused real words ("I am form Pakistan", "more then you") — a port of extension/src/offline/confusion.ts.
/// Both spellings are dictionary words, so the trained word-pair model decides which one fits.
/// </summary>
public static partial class ConfusionChecker
{
    [GeneratedRegex(@"[\p{L}'’]+")]
    private static partial Regex Word();

    [GeneratedRegex(@"^[ \t]+$")]
    private static partial Regex SpacesOnly();

    public static List<OfflineIssue> Issues(string text, LanguageModel model)
    {
        var help = RuleSet.Data.Maps.TryGetValue("confusionHelp", out var h) ? h : null;
        var words = Word().Matches(text).Select(m => (W: m.Value, Start: m.Index, End: m.Index + m.Length)).ToList();
        var issues = new List<OfflineIssue>();
        for (var i = 0; i < words.Count; i++)
        {
            var t = words[i];
            var lower = t.W.ToLowerInvariant();
            if (model.ConfusionSetOf(lower) is null) continue;
            if (t.W != lower && !(t.W[0] != lower[0] && t.W[1..] == lower[1..] && Speller.IsSentenceStart(text, t.Start))) continue;
            string? prev = null, next = null;
            if (i > 0 && SpacesOnly().IsMatch(text[words[i - 1].End..t.Start])) prev = words[i - 1].W.ToLowerInvariant().Replace('’', '\'');
            if (i + 1 < words.Count && SpacesOnly().IsMatch(text[t.End..words[i + 1].Start])) next = words[i + 1].W.ToLowerInvariant().Replace('’', '\'');
            var alt = model.ConfusionCheck(lower, prev, next);
            if (alt is null) continue;
            var replacement = RuleSet.MatchCase(t.W, alt);
            var explanation = help is not null && help.TryGetValue(alt, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            issues.Add(new OfflineIssue(t.Start, t.End, t.W, [replacement], "grammar", "warning", "Word choice",
                explanation is null ? $"Did you mean “{replacement}”?" : $"Did you mean “{replacement}”? {explanation}",
                "WM_CONFUSED_WORD", 0.8, FromRule: false));
        }
        return issues;
    }
}
