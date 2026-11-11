using System.Globalization;

namespace WriteMind.Core.Offline;

/// <summary>A set of commonly confused real words ("then|than") and the margin learned for it.</summary>
public sealed record ConfusionSet(IReadOnlyList<string> Words, int Margin, string Title);

/// <summary>
/// WriteMind's trained language model — a line-for-line port of extension/src/offline/model.ts.
/// Word statistics (Google Books n-grams via SymSpell), a typing-error model learned from real misspellings,
/// and context models for confused words. All scores are integer costs (−1000 × ln p), so this class and the
/// Chrome extension make exactly the same choices (proven by the shared parity fixture).
/// </summary>
public sealed class LanguageModel
{
    public const int Us = 1;
    public const int Gb = 2;
    public const int Proper = 4;
    public const int Extra = 8;

    private static readonly Lazy<LanguageModel> EnglishModel = new(LoadEmbedded);

    private readonly Dictionary<string, int> _ids = new(StringComparer.Ordinal);
    private readonly List<string> _words = [];
    private readonly List<int> _costs = [];
    private readonly List<byte> _flags = [];
    private readonly List<byte> _hist = [];
    private readonly Dictionary<string, int> _bigrams = new(StringComparer.Ordinal);
    private readonly List<List<int>> _byLength = [];
    private readonly Dictionary<string, ConfusionSet> _confusionIndex = new(StringComparer.Ordinal);
    private readonly int[] _sub = new int[27 * 27];
    private readonly int[] _ins = new int[27];
    private readonly int[] _del = new int[27];
    private int _trans = 3000;
    private int _insDouble = 2000;
    private int _delDouble = 2000;

    public int EditWeight { get; private set; } = 1000;
    public int NextWeight { get; private set; } = 1000;
    public int Backoff { get; private set; } = 2300;
    public int MaxCost { get; private set; } = 9000;
    public int Unknown { get; private set; } = 18000;
    public int MaxEdit { get; private set; } = 25000;
    public int Compound { get; private set; } = 12000;
    public int CompoundEdit { get; private set; } = 12000;
    public int Cutoff { get; private set; } = 8000;

    public List<ConfusionSet> Confusions { get; } = [];

    /// <summary>The English model embedded in WriteMind.Core (shared/model/en.model.txt).</summary>
    public static LanguageModel English => EnglishModel.Value;

    public int Size => _words.Count;

    private static LanguageModel LoadEmbedded()
    {
        using var stream = typeof(LanguageModel).Assembly.GetManifestResourceStream("WriteMind.Core.Offline.en.model.txt")
            ?? throw new InvalidOperationException("Language model missing.");
        using var reader = new StreamReader(stream);
        return Parse(reader.ReadToEnd());
    }

    private static int Letter(char ch)
    {
        var c = ch - 'a';
        return c is >= 0 and < 26 ? c : -1;
    }

    private static int Code(string s, int i)
    {
        var c = Letter(s[i]);
        return c < 0 ? 26 : c;
    }

    private static int Num(string s) => int.Parse(s, NumberStyles.Integer, CultureInfo.InvariantCulture);

    public static LanguageModel Parse(string text)
    {
        var m = new LanguageModel();
        Array.Fill(m._sub, 9000);
        Array.Fill(m._ins, 9000);
        Array.Fill(m._del, 9000);
        var section = "";
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0 || line[0] == '#') continue;
            if (line[0] == '@')
            {
                var parts = line.Split('\t');
                section = parts[0][1..];
                if (section == "weights")
                {
                    foreach (var kv in parts.Skip(1))
                    {
                        var eq = kv.IndexOf('=', StringComparison.Ordinal);
                        m.SetWeight(kv[..eq], Num(kv[(eq + 1)..]));
                    }
                }
                continue;
            }
            var f = line.Split('\t');
            switch (section)
            {
                case "edits":
                {
                    static int Idx(string s) => s == "*" ? 26 : Letter(s[0]);
                    switch (f[0])
                    {
                        case "sub": m._sub[Idx(f[1]) * 27 + Idx(f[2])] = Num(f[3]); break;
                        case "ins": m._ins[Idx(f[1])] = Num(f[2]); break;
                        case "del": m._del[Idx(f[1])] = Num(f[2]); break;
                        case "trans": m._trans = Num(f[1]); break;
                        case "insdouble": m._insDouble = Num(f[1]); break;
                        case "deldouble": m._delDouble = Num(f[1]); break;
                    }
                    break;
                }
                case "unigrams":
                {
                    var word = f[0];
                    var id = m._words.Count;
                    m._words.Add(word);
                    m._ids[word] = id;
                    m._costs.Add(Num(f[1]));
                    m._flags.Add((byte)Num(f[2]));
                    var hist = new byte[27];
                    foreach (var ch in word)
                    {
                        var c = Letter(ch);
                        hist[c < 0 ? 26 : c]++;
                    }
                    m._hist.AddRange(hist);
                    while (m._byLength.Count <= word.Length) m._byLength.Add([]);
                    m._byLength[word.Length].Add(id);
                    break;
                }
                case "bigrams":
                    m._bigrams[f[0]] = Num(f[1]);
                    break;
                case "confusion":
                {
                    var set = new ConfusionSet(f[0].Split('|'), Num(f[1]), f.Length > 2 ? f[2] : "Word choice");
                    m.Confusions.Add(set);
                    foreach (var w in set.Words) m._confusionIndex[w] = set;
                    break;
                }
            }
        }
        return m;
    }

    private void SetWeight(string name, int value)
    {
        switch (name)
        {
            case "edit": EditWeight = value; break;
            case "next": NextWeight = value; break;
            case "backoff": Backoff = value; break;
            case "maxCost": MaxCost = value; break;
            case "unknown": Unknown = value; break;
            case "maxEdit": MaxEdit = value; break;
            case "compound": Compound = value; break;
            case "compoundEdit": CompoundEdit = value; break;
            case "cutoff": Cutoff = value; break;
        }
    }

    /// <summary>−1000·ln P(word); words outside the vocabulary get a large fixed cost.</summary>
    public int Unigram(string word) => _ids.TryGetValue(word, out var id) ? _costs[id] : Unknown;

    /// <summary>Dictionary flags of a known word (US = 1, GB = 2, proper noun = 4, extra = 8), or 0.</summary>
    public int WordFlags(string word) => _ids.TryGetValue(word, out var id) ? _flags[id] : 0;

    /// <summary>Cost of seeing <paramref name="second"/> right after <paramref name="first"/> (stupid back-off).</summary>
    public int Follow(string? first, string second)
    {
        if (!string.IsNullOrEmpty(first))
        {
            return _bigrams.TryGetValue(first + " " + second, out var c) ? c : Backoff + Unigram(second);
        }
        return Unigram(second);
    }

    /// <summary>How well <paramref name="word"/> fits between its neighbours (lower is better).</summary>
    public int ContextCost(string word, string? prev, string? next)
    {
        var cost = Follow(prev, word);
        if (!string.IsNullOrEmpty(next)) cost += (int)((long)Follow(word, next) * NextWeight / 1000);
        return cost;
    }

    /// <summary>An unknown word made of two common words ("shockwaves") — usually a valid compound.</summary>
    public bool IsCompound(string word, int variant)
    {
        if (word.Length < 6) return false;
        bool Ok(string part) => _ids.TryGetValue(part, out var id) && (_flags[id] & variant) != 0 && (_flags[id] & Proper) == 0 && _costs[id] <= Compound;
        for (var i = 3; i <= word.Length - 3; i++)
        {
            if (Ok(word[..i]) && Ok(word[i..])) return true;
        }
        return false;
    }

    public bool HasBigram(string first, string second) => _bigrams.ContainsKey(first + " " + second);

    public ConfusionSet? ConfusionSetOf(string word) => _confusionIndex.GetValueOrDefault(word);

    /// <summary>
    /// For a word from a confused-word set: the alternative that fits the neighbours best and by how much
    /// (cost of the written word minus cost of the alternative).
    /// </summary>
    public (string Alternative, int Gain)? ConfusionGain(string word, string? prev, string? next)
    {
        if (!_confusionIndex.TryGetValue(word, out var set) || (string.IsNullOrEmpty(prev) && string.IsNullOrEmpty(next))) return null;
        string? best = null;
        var bestGain = 0;
        foreach (var alt in set.Words)
        {
            if (alt == word) continue;
            var gain = 0;
            var evidence = false;
            var veto = false;
            // A pair missing from the list was seen fewer than `cutoff` times, which bounds how likely it can be;
            // otherwise the usual back-off estimate applies. Every neighbour must have been seen with one of the
            // two words, and a neighbour that prefers the written word (or was only seen with it) vetoes the change.
            if (!string.IsNullOrEmpty(prev))
            {
                var hasOwn = _bigrams.TryGetValue(prev + " " + word, out var own);
                if (_bigrams.TryGetValue(prev + " " + alt, out var other))
                {
                    evidence = true;
                    var ownCost = hasOwn ? own : Math.Max(Cutoff - Unigram(prev), Backoff + Unigram(word));
                    if (ownCost < other) veto = true;
                    else gain += ownCost - other;
                }
                else
                {
                    veto = true;
                }
            }
            if (!string.IsNullOrEmpty(next))
            {
                var hasOwn = _bigrams.TryGetValue(word + " " + next, out var own);
                if (_bigrams.TryGetValue(alt + " " + next, out var other))
                {
                    evidence = true;
                    var ownCost = hasOwn ? own : Math.Max(Cutoff - Unigram(word), Backoff + Unigram(next));
                    if (ownCost < other) veto = true;
                    else gain += (int)((long)(ownCost - other) * NextWeight / 1000);
                }
                else
                {
                    veto = true;
                }
            }
            if (veto) continue;
            if (evidence && (best is null || gain > bestGain))
            {
                best = alt;
                bestGain = gain;
            }
        }
        return best is null ? null : (best, bestGain);
    }

    /// <summary>The likely intended word if the written one is a confused-word mistake, else null.</summary>
    public string? ConfusionCheck(string word, string? prev, string? next)
    {
        var r = ConfusionGain(word, prev, next);
        return r is { } g && g.Gain > _confusionIndex[word].Margin ? g.Alternative : null;
    }

    /// <summary>Learned cost of typing <paramref name="typo"/> when <paramref name="word"/> was meant (weighted OSA).</summary>
    public int EditCost(string typo, string word)
    {
        var n = typo.Length;
        var m = word.Length;
        var w = m + 1;
        var d = new int[(n + 1) * w];
        for (var j = 1; j <= m; j++) d[j] = d[j - 1] + DelCost(word, j - 1);
        for (var i = 1; i <= n; i++)
        {
            d[i * w] = d[(i - 1) * w] + InsCost(typo, i - 1);
            for (var j = 1; j <= m; j++)
            {
                var a = typo[i - 1];
                var b = word[j - 1];
                var best = d[(i - 1) * w + j - 1] + (a == b ? 0 : _sub[Code(word, j - 1) * 27 + Code(typo, i - 1)]);
                var insertion = d[(i - 1) * w + j] + InsCost(typo, i - 1);
                if (insertion < best) best = insertion;
                var deletion = d[i * w + j - 1] + DelCost(word, j - 1);
                if (deletion < best) best = deletion;
                if (i > 1 && j > 1 && a == word[j - 2] && typo[i - 2] == b && a != b)
                {
                    var t = d[(i - 2) * w + j - 2] + _trans;
                    if (t < best) best = t;
                }
                d[i * w + j] = best;
            }
        }
        return d[n * w + m];
    }

    private int InsCost(string typo, int i) => i > 0 && typo[i] == typo[i - 1] ? _insDouble : _ins[Code(typo, i)];

    private int DelCost(string word, int j) => j > 0 && word[j] == word[j - 1] ? _delDouble : _del[Code(word, j)];

    /// <summary>Ranked corrections for a misspelled (lower-case) word, using the neighbouring words as context.</summary>
    public IReadOnlyList<string> Suggest(string typo, int variant, string? prev, string? next, int limit = 4)
    {
        var n = typo.Length;
        if (n is < 2 or > 30) return [];
        var maxEdits = n <= 4 ? 1 : n <= 7 ? 2 : 3;
        var th = new int[27];
        foreach (var ch in typo)
        {
            var c = Letter(ch);
            th[c < 0 ? 26 : c]++;
        }
        var scored = new List<(string Word, int Score)>();
        for (var len = Math.Max(1, n - maxEdits); len <= n + maxEdits; len++)
        {
            if (len >= _byLength.Count) break;
            foreach (var id in _byLength[len])
            {
                if ((_flags[id] & variant) == 0) continue;
                int more = 0, less = 0, baseIndex = id * 27;
                for (var k = 0; k < 27; k++)
                {
                    var diff = th[k] - _hist[baseIndex + k];
                    if (diff > 0) more += diff;
                    else less -= diff;
                }
                if ((more > less ? more : less) > maxEdits) continue;
                var word = _words[id];
                if (OsaWithin(typo, word, maxEdits) < 0) continue;
                var edit = (int)((long)EditCost(typo, word) * EditWeight / 1000);
                if (edit > MaxEdit) continue;
                scored.Add((word, edit + ContextCost(word, prev, next)));
            }
        }
        if (scored.Count == 0) return [];
        scored.Sort((a, b) => a.Score != b.Score ? a.Score.CompareTo(b.Score) : string.CompareOrdinal(a.Word, b.Word));
        var cutoff = scored[0].Score + MaxCost;
        return scored.Where(s => s.Score <= cutoff).Take(limit).Select(s => s.Word).ToList();
    }

    /// <summary>Unit-cost OSA distance, or −1 when it exceeds <paramref name="max"/>.</summary>
    public static int OsaWithin(string a, string b, int max)
    {
        var n = a.Length;
        var m = b.Length;
        if (Math.Abs(n - m) > max) return -1;
        var w = m + 1;
        var big = max + 1;
        var d = new int[(n + 1) * w];
        Array.Fill(d, big);
        for (var j = 0; j <= Math.Min(m, max); j++) d[j] = j;
        for (var i = 1; i <= n; i++)
        {
            if (i <= max) d[i * w] = i;
            var rowMin = i <= max ? i : big;
            var lo = Math.Max(1, i - max);
            var hi = Math.Min(m, i + max);
            for (var j = lo; j <= hi; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                var v = d[(i - 1) * w + j - 1] + cost;
                var up = d[(i - 1) * w + j] + 1;
                if (up < v) v = up;
                var left = d[i * w + j - 1] + 1;
                if (left < v) v = left;
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1])
                {
                    var t = d[(i - 2) * w + j - 2] + 1;
                    if (t < v) v = t;
                }
                if (v > big) v = big;
                d[i * w + j] = v;
                if (v < rowMin) rowMin = v;
            }
            if (rowMin > max) return -1;
        }
        var r = d[n * w + m];
        return r > max ? -1 : r;
    }
}
