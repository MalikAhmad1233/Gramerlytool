using System.Globalization;
using WriteMind.Core.Api;

namespace WriteMind.Core.Text;

/// <summary>One contiguous change: old[Start, OldEnd) became new[Start, NewEnd).</summary>
public readonly record struct TextEdit(int Start, int OldEnd, int NewEnd)
{
    public int Delta => NewEnd - OldEnd;
}

/// <summary>Offset bookkeeping shared by every integration (same semantics as the Chrome extension).</summary>
public static class TextDiff
{
    public static TextEdit? DiffRegion(string oldText, string newText)
    {
        if (string.Equals(oldText, newText, StringComparison.Ordinal)) return null;
        var start = 0;
        var min = Math.Min(oldText.Length, newText.Length);
        while (start < min && oldText[start] == newText[start]) start++;
        int oldEnd = oldText.Length, newEnd = newText.Length;
        while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] == newText[newEnd - 1])
        {
            oldEnd--;
            newEnd--;
        }
        return new TextEdit(start, oldEnd, newEnd);
    }

    /// <summary>
    /// Moves suggestions computed for <paramref name="oldText"/> onto <paramref name="newText"/>.
    /// Suggestions whose span (or the word it belongs to) was edited are dropped; survivors are verified.
    /// </summary>
    public static IReadOnlyList<Suggestion> Rebase(IReadOnlyList<Suggestion> list, string oldText, string newText)
    {
        var edit = DiffRegion(oldText, newText);
        if (edit is null) return list;
        var e = edit.Value;
        var result = new List<Suggestion>(list.Count);
        foreach (var s in list)
        {
            int offset;
            if (s.End < e.Start || (s.End == e.Start && !GluesAfter(newText, e.Start, s.Original)))
                offset = s.Offset;
            else if (s.Offset > e.OldEnd || (s.Offset == e.OldEnd && !GluesBefore(newText, e.NewEnd, s.Original)))
                offset = s.Offset + e.Delta;
            else
                continue;
            if (offset < 0 || offset + s.Length > newText.Length) continue;
            if (!string.Equals(newText.Substring(offset, s.Length), s.Original, StringComparison.Ordinal)) continue;
            result.Add(offset == s.Offset ? s : s with { Offset = offset });
        }
        return result;
    }

    /// <summary>
    /// True if <c>text[start, end)</c> still equals <paramref name="expected"/> and still stands alone as the
    /// same token(s). After "go" → "goes" the span reads "go" but is part of a longer word, so it is invalid.
    /// </summary>
    public static bool SpanStillValid(string text, int start, int end, string expected, bool wholeWords = true)
    {
        if (start < 0 || end > text.Length || end < start) return false;
        if (!string.Equals(text[start..end], expected, StringComparison.Ordinal)) return false;
        if (!wholeWords || expected.Length == 0) return true;
        if (start > 0 && IsBoundaryWordChar(expected[0]) && IsBoundaryWordChar(text[start - 1])) return false;
        if (end < text.Length && IsBoundaryWordChar(expected[^1]) && IsBoundaryWordChar(text[end])) return false;
        return true;
    }

    public static bool Overlaps(Suggestion a, Suggestion b)
    {
        var aEnd = a.Offset + Math.Max(a.Length, 1);
        var bEnd = b.Offset + Math.Max(b.Length, 1);
        return a.Offset < bEnd && b.Offset < aEnd;
    }

    private static bool GluesAfter(string text, int boundary, string original) =>
        boundary < text.Length && original.Length > 0 && IsWordChar(text[boundary]) && IsWordChar(original[^1]);

    private static bool GluesBefore(string text, int boundary, string original) =>
        boundary > 0 && original.Length > 0 && IsWordChar(text[boundary - 1]) && IsWordChar(original[0]);

    private static bool IsWordChar(char c) => char.IsLetterOrDigit(c) || c is '_' or '\'' or '’';

    /// <summary>Latin/Greek/Cyrillic letters, digits, apostrophes — scripts that separate words with spaces.</summary>
    private static bool IsBoundaryWordChar(char c)
    {
        if (char.IsDigit(c) || c is '_' or '\'' or '’') return true;
        if (!char.IsLetter(c)) return false;
        return c < 0x0530 || (c >= 0x1E00 && c <= 0x1FFF); // Latin, Greek, Cyrillic + extended blocks
    }
}

/// <summary>Finds a span again when a host app's text offsets drift slightly (e.g. CRLF vs CR).</summary>
public static class TextSpanLocator
{
    /// <summary>How many times <paramref name="original"/> occurs before <paramref name="offset"/>.</summary>
    public static int OccurrenceIndex(string text, int offset, string original)
    {
        if (original.Length == 0) return 0;
        var count = 0;
        var i = text.IndexOf(original, StringComparison.Ordinal);
        while (i >= 0 && i < offset)
        {
            count++;
            i = text.IndexOf(original, i + 1, StringComparison.Ordinal);
        }
        return count;
    }

    /// <summary>Nearest occurrence of <paramref name="original"/> to <paramref name="offset"/> within a window.</summary>
    public static int? FindNear(string text, int offset, string original, int window = 64)
    {
        if (original.Length == 0) return null;
        int? best = null;
        var from = Math.Max(0, offset - window);
        var to = Math.Min(text.Length, offset + window + original.Length);
        var i = text.IndexOf(original, from, StringComparison.Ordinal);
        while (i >= 0 && i + original.Length <= to)
        {
            if (best is null || Math.Abs(i - offset) < Math.Abs(best.Value - offset)) best = i;
            i = text.IndexOf(original, i + 1, StringComparison.Ordinal);
        }
        return best;
    }
}

public static class SentenceFinder
{
    /// <summary>The sentence containing <paramref name="caret"/> (used for Rewrite when nothing is selected).</summary>
    public static (int Start, int End) Around(string text, int caret)
    {
        caret = Math.Clamp(caret, 0, text.Length);
        var start = 0;
        for (var i = 0; i < caret; i++)
        {
            var c = text[i];
            if (c is '\n' or '\r' || (IsTerminal(c) && i + 1 < text.Length && char.IsWhiteSpace(text[i + 1]) && i + 1 < caret))
                start = i + 1;
        }
        var end = text.Length;
        for (var i = Math.Max(caret, start); i < text.Length; i++)
        {
            var c = text[i];
            if (c is '\n' or '\r') { end = i; break; }
            if (IsTerminal(c) && (i + 1 == text.Length || char.IsWhiteSpace(text[i + 1]))) { end = i + 1; break; }
        }
        while (start < end && char.IsWhiteSpace(text[start])) start++;
        while (end > start && char.IsWhiteSpace(text[end - 1])) end--;
        return (start, end);
    }

    private static bool IsTerminal(char c) => c is '.' or '!' or '?' or '…';
}

public static class WordCounter
{
    public static int Count(string text)
    {
        var count = 0;
        var inWord = false;
        foreach (var c in text)
        {
            var word = char.IsLetterOrDigit(c) || c is '\'' or '’' || CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark;
            if (word && !inWord) count++;
            inWord = word;
        }
        return count;
    }
}
