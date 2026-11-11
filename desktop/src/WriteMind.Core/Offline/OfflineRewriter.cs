using System.Text.RegularExpressions;
using WriteMind.Core.Api;

namespace WriteMind.Core.Offline;

/// <summary>Style rewrites without a server (same transforms as the extension and the API's offline fallback).</summary>
public static partial class OfflineRewriter
{
    private static RewriteData Rw => RuleSet.Data.Rewrite;

    private static string SubPreservingCase(string pattern, string replacement, string text) =>
        Regex.Replace(text, pattern, m =>
        {
            var found = m.Value;
            if (replacement.Length > 0 && found.Length > 0 && char.IsUpper(found[0]))
                return char.ToUpperInvariant(replacement[0]) + replacement[1..];
            if (replacement.Length > 0 && found.Length > 0 && char.IsLower(found[0]) && char.IsUpper(replacement[0]) && replacement != "I")
            {
                if (!SentenceStartBefore().IsMatch(text[..m.Index])) return char.ToLowerInvariant(replacement[0]) + replacement[1..];
            }
            return replacement;
        }, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    [GeneratedRegex(@"(^|[.!?]\s+)$")]
    private static partial Regex SentenceStartBefore();

    [GeneratedRegex(@"(?<![\w'’])[A-Za-z]+['’][a-z]+(?![\w'’])")]
    private static partial Regex ContractionWord();

    public static string ExpandContractions(string text) =>
        ContractionWord().Replace(text, m =>
        {
            var values = RuleSet.Data.MapValues("formalContractions", m.Value.ToLowerInvariant().Replace('’', '\''));
            if (values.Count == 0) return m.Value;
            var e = values[0];
            return char.IsUpper(m.Value[0]) ? char.ToUpperInvariant(e[0]) + e[1..] : e;
        });

    public static string Contract(string text)
    {
        foreach (var pair in Rw.Contract) text = SubPreservingCase($@"\b{Regex.Escape(pair[0])}\b", pair[1], text);
        return text;
    }

    private static string ReplaceInformal(string text, bool formal)
    {
        var entries = RuleSet.Data.Maps["informal"].Keys.Select(k => ("informal", k)).ToList();
        if (formal) entries.AddRange(RuleSet.Data.Maps["informalFormal"].Keys.Select(k => ("informalFormal", k)));
        foreach (var (map, word) in entries)
        {
            var list = RuleSet.Data.MapValues(map, word);
            var choice = formal && list.Count > 1 && word is "thx" or "thanx" or "dunno" ? list[^1] : list[0];
            var pattern = @"(?<![\w'’@#])" + Regex.Escape(word).Replace("'", "['’]", StringComparison.Ordinal) + @"(?![\w'’])";
            text = SubPreservingCase(pattern, choice, text);
        }
        return text;
    }

    [GeneratedRegex(@"(?<![\w'’])i(?![\w'’])")]
    private static partial Regex LowerI();

    [GeneratedRegex(@"\bi(['’](?:m|ve|ll|d))\b")]
    private static partial Regex LowerIContraction();

    [GeneratedRegex(@"([!?])\1+")]
    private static partial Regex RepeatedMark();

    [GeneratedRegex(@"[ \t]{2,}")]
    private static partial Regex MultiSpace();

    [GeneratedRegex(@"\s+([,.;:!?])")]
    private static partial Regex SpaceBeforePunctuation();

    [GeneratedRegex(@"^(\s*(?:[Hh]ello|[Hh]i|[Hh]ey|[Gg]reetings|[Gg]ood (?:morning|afternoon|evening)))(?=\s+(?:I\b|[a-z]))")]
    private static partial Regex Greeting();

    [GeneratedRegex(@"(^\s*|[.!?]\s+)([a-z])")]
    private static partial Regex SentenceStartLower();

    [GeneratedRegex(@"(?<=[.!?])\s+")]
    private static partial Regex SentenceBreak();

    public static string Tidy(string text)
    {
        text = LowerI().Replace(text, "I");
        text = LowerIContraction().Replace(text, "I$1");
        text = RepeatedMark().Replace(text, "$1");
        text = MultiSpace().Replace(text, " ");
        text = SpaceBeforePunctuation().Replace(text, "$1");
        text = Greeting().Replace(text, "$1,");
        text = SentenceStartLower().Replace(text, m => m.Groups[1].Value + m.Groups[2].Value.ToUpperInvariant());
        var stripped = text.TrimEnd();
        if (stripped.Length > 0 && char.IsLetterOrDigit(stripped[^1]))
        {
            var lastSentence = SentenceBreak().Split(stripped)[^1];
            var mark = Regex.IsMatch(lastSentence, Rw.QuestionStart, RegexOptions.IgnoreCase) ? "?" : ".";
            text = stripped + mark + text[stripped.Length..];
        }
        return text;
    }

    public static string Transform(string text, string style)
    {
        var output = text;
        switch (style)
        {
            case "professional" or "formal":
                output = ReplaceInformal(output, style == "formal");
                output = Regex.Replace(output, Rw.FillersProfessional, "", RegexOptions.IgnoreCase);
                if (style == "formal")
                {
                    output = ExpandContractions(output);
                    foreach (var pair in Rw.FormalPhrases) output = SubPreservingCase(pair[0], pair[1], output);
                }
                break;
            case "casual" or "friendly":
                output = Contract(output);
                foreach (var pair in Rw.CasualPhrases) output = SubPreservingCase(pair[0], pair[1], output);
                if (style == "friendly") output = ReplaceInformal(output, false);
                break;
            case "concise":
                foreach (var pair in Rw.ConcisePhrases) output = SubPreservingCase(pair[0], pair[1], output);
                output = Regex.Replace(output, Rw.FillersConcise, "", RegexOptions.IgnoreCase);
                output = ReplaceInformal(output, false);
                break;
        }
        return Tidy(output);
    }

    private static string Normalise(string s) => Regex.Replace(s, @"\s+", " ").Trim().ToLowerInvariant();

    public static RewriteResponse Rewrite(string text, string style, int count, string language, Speller? speller)
    {
        var started = DateTime.UtcNow;
        var source = text.Trim();
        var fixes = OfflineEngine.FindIssues(source, new OfflineOptions(language, "neutral", null), speller)
            .Where(i => i.Category is not ("style" or "clarity") && i.Replacements.Count > 0 && i.Confidence >= 0.85)
            .ToList();
        var corrected = source;
        foreach (var f in fixes.OrderByDescending(f => f.Start))
            corrected = corrected[..f.Start] + f.Replacements[0] + corrected[f.End..];

        var candidates = new List<(string Text, List<string> Notes)>();
        if (language.StartsWith("en", StringComparison.OrdinalIgnoreCase))
        {
            var notes = new List<string> { $"Adjusted for a {style} tone" };
            if (fixes.Count > 0) notes.Insert(0, $"{fixes.Count} correction(s) applied");
            candidates.Add((Transform(corrected, style).Trim(), notes));
        }
        if (fixes.Count > 0) candidates.Add((corrected.Trim(), [$"{fixes.Count} correction(s) applied only"]));

        var seen = new HashSet<string> { Normalise(source) };
        var alternatives = new List<RewriteAlternative>();
        foreach (var (candidate, notes) in candidates)
        {
            if (candidate.Length == 0 || !seen.Add(Normalise(candidate))) continue;
            alternatives.Add(new RewriteAlternative(candidate, "rules", true, notes));
            if (alternatives.Count >= count) break;
        }
        return new RewriteResponse(style, alternatives, "rules", (DateTime.UtcNow - started).TotalMilliseconds);
    }
}
