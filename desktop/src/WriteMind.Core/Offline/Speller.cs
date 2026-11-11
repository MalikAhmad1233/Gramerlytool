using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using WeCantSpell.Hunspell;

namespace WriteMind.Core.Offline;

/// <summary>
/// Spelling — a port of extension/src/offline/speller.ts. Hunspell (same dictionaries as the extension) decides
/// whether a word is correct; WriteMind's trained <see cref="LanguageModel"/> decides what was most likely meant.
/// </summary>
public sealed partial class Speller
{
    private static readonly ConcurrentDictionary<string, Lazy<Speller>> Instances = new();
    private static readonly HashSet<string> Particles = RuleSet.Data.NameParticles.ToHashSet(StringComparer.Ordinal);
    private readonly WordList _words;
    private readonly HashSet<string> _allow;
    private readonly ConcurrentDictionary<string, bool> _cache = new();
    private readonly ConcurrentDictionary<string, IReadOnlyList<string>> _suggestions = new();

    private Speller(WordList words, LanguageModel? model, int variant)
    {
        _words = words;
        Model = model;
        Variant = variant;
        _allow = RuleSet.Data.AllowWords.Select(w => w.ToLowerInvariant()).ToHashSet();
    }

    public LanguageModel? Model { get; }

    /// <summary><see cref="LanguageModel.Us"/> or <see cref="LanguageModel.Gb"/>.</summary>
    public int Variant { get; }

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
        return new Speller(WordList.CreateFromStreams(dic, aff), LanguageModel.English, name == "en-GB" ? LanguageModel.Gb : LanguageModel.Us);
    }

    /// <summary>A valid-looking compound of two common words that the dictionary doesn't list.</summary>
    public bool IsCompound(string word) =>
        !RuleSet.Data.Typos.ContainsKey(word.ToLowerInvariant()) && (Model?.IsCompound(word.ToLowerInvariant(), Variant) ?? false);

    public bool IsProperNoun(string word) => ((Model?.WordFlags(word.ToLowerInvariant()) ?? 0) & LanguageModel.Proper) != 0;

    /// <summary>True if <paramref name="correction"/> is only a slip or two away from <paramref name="word"/>.</summary>
    public bool IsCloseCorrection(string word, string? correction)
    {
        if (correction is null || Model is null) return false;
        var cost = (int)((long)Model.EditCost(word.ToLowerInvariant(), correction.ToLowerInvariant()) * Model.EditWeight / 1000);
        return cost <= Model.CompoundEdit;
    }

    /// <summary>True if the word is a correct spelling in the other variety of English (colour/color).</summary>
    public bool IsOtherVariant(string word)
    {
        if (Model is null) return false;
        var flags = Model.WordFlags(word.ToLowerInvariant().Replace('’', '\''));
        var other = Variant == LanguageModel.Us ? LanguageModel.Gb : LanguageModel.Us;
        return (flags & other) != 0 && (flags & Variant) == 0;
    }

    public bool IsCorrect(string word) => _cache.GetOrAdd(word, w =>
    {
        w = w.Replace('’', '\'');
        var lower = w.ToLowerInvariant();
        var ok = _allow.Contains(lower) || _words.Check(w) || ((Model?.WordFlags(lower) ?? 0) & LanguageModel.Extra) != 0;
        if (!ok && (w.EndsWith("'s", StringComparison.OrdinalIgnoreCase))) ok = _words.Check(w[..^2]);
        if (!ok && w.Length > 0 && w[0] != lower[0] && w[1..] == lower[1..]) ok = _words.Check(lower);
        return ok;
    });

    public IReadOnlyList<string> Suggest(string word, string? prev = null, string? next = null) => _suggestions.GetOrAdd($"{word}|{prev}|{next}", _ =>
    {
        var lower = word.ToLowerInvariant().Replace('’', '\'');
        List<string> output;
        if (RuleSet.Data.Typos.TryGetValue(lower, out var typo))
        {
            output = [typo];
        }
        else if (Model is not null)
        {
            output = Model.Suggest(lower, Variant, prev, next)
                .Select(s => (Model.WordFlags(s) & LanguageModel.Proper) != 0 ? char.ToUpperInvariant(s[0]) + s[1..] : s).ToList();
        }
        else if (word.Length <= 20)
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
        return output.Select(s => s.Length > 0 && char.IsUpper(s[0]) ? s : RuleSet.MatchCase(word, s)).ToList();
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

    internal static bool IsSentenceStart(string text, int start)
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
                // Letters outside English (ü, é, ñ…) mean a name or a foreign word, not a typo.
                if (NonEnglishLetter().IsMatch(word)) continue;
                // colour/color: a correct spelling in the other variety of English gets a gentle note, not an error.
                if (IsOtherVariant(word))
                {
                    var american = Variant == LanguageModel.Us;
                    issues.Add(new OfflineIssue(s, s + word.Length, word, Suggest(word).Take(1).ToList(), "spelling", "suggestion",
                        american ? "American spelling" : "British spelling",
                        american
                            ? $"“{word}” is the British spelling. Your language is set to American English."
                            : $"“{word}” is the American spelling. Your language is set to British English.",
                        "WM_SPELLING_VARIANT", 0.7, FromRule: false));
                    continue;
                }
                if (capitalised && LooksLikeName(text, PossessiveS().Replace(word, ""), s)) continue;
                if (!capitalised && Particles.Contains(word) && FollowedByCapital().IsMatch(text[(s + word.Length)..Math.Min(text.Length, s + word.Length + 3)])) continue;
                var suggestions = Suggest(word, Neighbour(text, s, s + word.Length, before: true), Neighbour(text, s, s + word.Length, before: false));
                var first = suggestions.Count > 0 ? suggestions[0] : null;
                // A capitalised unknown word (at the start of a sentence here) is usually a name; only flag it
                // when it is a slip or two away from an ordinary word.
                if (capitalised && !(first is not null && !IsProperNoun(first) && IsCloseCorrection(word, first))) continue;
                if (!capitalised && IsCompound(word) && !IsCloseCorrection(word, first)) continue;
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

    [GeneratedRegex("[^A-Za-z'’]")]
    private static partial Regex NonEnglishLetter();

    [GeneratedRegex("['’]s$")]
    private static partial Regex PossessiveS();

    [GeneratedRegex(@"^[ \t]+[A-Z]")]
    private static partial Regex FollowedByCapital();

    [GeneratedRegex(@"^[ \t]+\p{Lu}\p{Ll}")]
    private static partial Regex FollowedByName();

    [GeneratedRegex(@"([\p{L}'’]+)[ \t]+$")]
    private static partial Regex WordBefore();

    [GeneratedRegex(@"^[ \t]+([\p{L}'’]+)")]
    private static partial Regex WordAfter();

    /// <summary>The neighbouring word, if only spaces separate it from the span (the model's word-pair context).</summary>
    private static string? Neighbour(string text, int start, int end, bool before)
    {
        var m = before
            ? WordBefore().Match(text[Math.Max(0, start - 40)..start])
            : WordAfter().Match(text[end..Math.Min(text.Length, end + 40)]);
        return m.Success ? m.Groups[1].Value.ToLowerInvariant().Replace('’', '\'') : null;
    }

    /// <summary>A capitalised unknown word at the start of a sentence is usually a name if it is used as one elsewhere.</summary>
    private static bool LooksLikeName(string text, string word, int start)
    {
        var end = start + word.Length;
        if (FollowedByName().IsMatch(text[end..Math.Min(text.Length, end + 4)])) return true;
        for (var i = text.IndexOf(word, StringComparison.Ordinal); i >= 0; i = text.IndexOf(word, i + 1, StringComparison.Ordinal))
        {
            if (i == start) continue;
            var after = i + word.Length;
            if ((i > 0 && char.IsLetterOrDigit(text[i - 1])) || (after < text.Length && char.IsLetterOrDigit(text[after]))) continue;
            if (!IsSentenceStart(text, i)) return true;
        }
        return false;
    }

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
