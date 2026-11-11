using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using WeCantSpell.Hunspell;

namespace WriteMind.Core.Offline;

/// <summary>Hunspell spelling (same dictionaries as the extension) with WriteMind's typo table, allow-list and ranking.</summary>
public sealed partial class Speller
{
    private static readonly ConcurrentDictionary<string, Lazy<Speller>> Instances = new();
    private readonly WordList _words;
    private readonly HashSet<string> _allow;
    private readonly ConcurrentDictionary<string, bool> _cache = new();
    private readonly ConcurrentDictionary<string, IReadOnlyList<string>> _suggestions = new();

    private Speller(WordList words)
    {
        _words = words;
        _allow = RuleSet.Data.AllowWords.Select(w => w.ToLowerInvariant()).ToHashSet();
    }

    /// <summary>British-style spelling for en-GB/AU/NZ/ZA, American for other English variants; null for other languages.</summary>
    public static Speller? For(string language)
    {
        if (!language.StartsWith("en", StringComparison.OrdinalIgnoreCase)) return null;
        var name = Regex.IsMatch(language, "^en-(GB|AU|NZ|ZA)$", RegexOptions.IgnoreCase) ? "en-GB" : "en-US";
        return Instances.GetOrAdd(name, n => new Lazy<Speller>(() => Load(n))).Value;
    }

    private static Speller Load(string name)
    {
        var assembly = typeof(Speller).Assembly;
        using var dic = assembly.GetManifestResourceStream($"WriteMind.Core.Offline.{name}.dic")
            ?? throw new InvalidOperationException($"Dictionary {name} missing.");
        using var aff = assembly.GetManifestResourceStream($"WriteMind.Core.Offline.{name}.aff")
            ?? throw new InvalidOperationException($"Affix file {name} missing.");
        return new Speller(WordList.CreateFromStreams(dic, aff));
    }

    public bool IsCorrect(string word) => _cache.GetOrAdd(word, w =>
    {
        w = w.Replace('’', '\'');
        var lower = w.ToLowerInvariant();
        var ok = _allow.Contains(lower) || _words.Check(w);
        if (!ok && (w.EndsWith("'s", StringComparison.OrdinalIgnoreCase))) ok = _words.Check(w[..^2]);
        if (!ok && w.Length > 0 && w[0] != lower[0] && w[1..] == lower[1..]) ok = _words.Check(lower);
        return ok;
    });

    public IReadOnlyList<string> Suggest(string word) => _suggestions.GetOrAdd(word, w =>
    {
        var lower = w.ToLowerInvariant().Replace('’', '\'');
        List<string> output;
        if (RuleSet.Data.Typos.TryGetValue(lower, out var typo))
        {
            output = [typo];
        }
        else if (w.Length <= 20)
        {
            var transpositions = new List<string>();
            for (var i = 0; i < lower.Length - 1; i++)
            {
                var swapped = string.Concat(lower.AsSpan(0, i), lower.AsSpan(i + 1, 1), lower.AsSpan(i, 1), lower.AsSpan(i + 2));
                if (swapped != lower && _words.Check(swapped)) transpositions.Add(swapped);
            }
            var ranked = _words.Suggest(lower)
                .Select((s, index) => (s, index, d: OsaDistance(lower, s.ToLowerInvariant())))
                .OrderBy(x => x.d).ThenBy(x => x.index)
                .Select(x => x.s);
            output = transpositions.Concat(ranked).Distinct().Take(4).ToList();
        }
        else
        {
            output = [];
        }
        return output.Select(s => s.Length > 0 && char.IsUpper(s[0]) ? s : RuleSet.MatchCase(w, s)).ToList();
    });

    public static int OsaDistance(string a, string b)
    {
        var d = new int[a.Length + 1, b.Length + 1];
        for (var i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (var j = 0; j <= b.Length; j++) d[0, j] = j;
        for (var i = 1; i <= a.Length; i++)
        {
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                var v = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + cost);
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) v = Math.Min(v, d[i - 2, j - 2] + 1);
                d[i, j] = v;
            }
        }
        return d[a.Length, b.Length];
    }

    [GeneratedRegex(@"[\p{L}\p{M}\p{N}_'’-]+")]
    private static partial Regex WordToken();

    [GeneratedRegex(@"\n[\s""'“‘(\[]*$")]
    private static partial Regex AfterNewline();

    [GeneratedRegex(@"[\s""'“‘(\[]+$")]
    private static partial Regex TrailingOpeners();

    private static bool IsSentenceStart(string text, int start)
    {
        var windowStart = Math.Max(0, start - 40);
        var before = text[windowStart..start];
        if (AfterNewline().IsMatch(before)) return true;
        var trimmed = TrailingOpeners().Replace(before, "");
        if (trimmed.Length == 0) return windowStart == 0;
        return trimmed[^1] is '.' or '!' or '?';
    }

    public List<OfflineIssue> Issues(string text, IReadOnlySet<string> dictionary)
    {
        var issues = new List<OfflineIssue>();
        foreach (Match m in WordToken().Matches(text))
        {
            var raw = m.Value;
            var leadTrimmed = raw.TrimStart('\'', '’', '-');
            var lead = raw.Length - leadTrimmed.Length;
            var token = leadTrimmed.TrimEnd('\'', '’', '-');
            var start = m.Index + lead;
            if (token.Length < 2 || token.Any(c => char.IsDigit(c) || c == '_')) continue;
            var parts = token.Contains('-', StringComparison.Ordinal) && !IsCorrect(token)
                ? SplitParts(token, start)
                : [(token, start)];
            foreach (var (word, s) in parts)
            {
                if (word.Length < 2) continue;
                if (!word.Any(char.IsLower)) continue; // acronyms
                if (MixedCase().IsMatch(word)) continue; // camelCase / brand names
                if (dictionary.Contains(word.ToLowerInvariant())) continue;
                var capitalised = char.IsUpper(word[0]);
                if (capitalised && !IsSentenceStart(text, s)) continue; // probably a name
                if (IsCorrect(word)) continue;
                var suggestions = Suggest(word);
                issues.Add(new OfflineIssue(s, s + word.Length, word, suggestions, "spelling", "error", "Spelling mistake",
                    suggestions.Count > 0
                        ? $"“{word}” may be misspelled."
                        : $"“{word}” isn't in the dictionary. If it's correct, add it to your dictionary.",
                    "WM_SPELLING", suggestions.Count > 0 ? 0.88 : 0.6, FromRule: false));
            }
        }
        return issues;
    }

    [GeneratedRegex("[a-z][A-Z]|^[A-Z]{2,}[a-z]")]
    private static partial Regex MixedCase();

    private static List<(string Word, int Start)> SplitParts(string token, int start)
    {
        var output = new List<(string, int)>();
        var offset = 0;
        foreach (var part in token.Split('-'))
        {
            output.Add((part, start + offset));
            offset += part.Length + 1;
        }
        return output;
    }
}
