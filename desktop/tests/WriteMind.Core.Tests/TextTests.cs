using WriteMind.Core.Api;
using WriteMind.Core.Text;

namespace WriteMind.Core.Tests;

internal static class Make
{
    public static Suggestion S(string text, string original, string source = "languagetool", string category = "grammar",
        string rule = "R", int from = 0)
    {
        var offset = text.IndexOf(original, from, StringComparison.Ordinal);
        if (offset < 0) throw new ArgumentException($"'{original}' not found");
        return new Suggestion
        {
            Id = $"s_{original}_{offset}",
            Fingerprint = $"f_{original}",
            Offset = offset,
            Length = original.Length,
            Original = original,
            Replacements = ["x"],
            Category = category,
            Severity = "error",
            Title = "t",
            Message = "m",
            RuleId = rule,
            Source = source,
            Confidence = 0.9,
        };
    }

    public static CheckResponse Response(IReadOnlyList<Suggestion> suggestions, string mode = "fast") => new(
        "hash", "en-US", "neutral", mode, suggestions,
        new CheckStats(0, 3, 1, new Dictionary<string, int>(), 88),
        new EngineInfo("ok", "skipped", 1, 0, 1));
}

public class TextDiffTests
{
    private const string Text = "She go to school and I recieved teh files.";
    private static readonly Suggestion[] List = [Make.S(Text, "go"), Make.S(Text, "recieved"), Make.S(Text, "teh")];

    [Fact]
    public void DiffRegionFindsSingleEdit()
    {
        Assert.Equal(new TextEdit(2, 4, 4), TextDiff.DiffRegion("abcdef", "abXYef"));
        Assert.Null(TextDiff.DiffRegion("same", "same"));
    }

    [Fact]
    public void RebaseShiftsLaterSuggestions()
    {
        var next = Text.Replace("school", "the big school", StringComparison.Ordinal);
        var result = TextDiff.Rebase(List, Text, next);
        Assert.Equal([4, next.IndexOf("recieved", StringComparison.Ordinal), next.IndexOf("teh", StringComparison.Ordinal)],
            result.Select(s => s.Offset));
    }

    [Fact]
    public void RebaseDropsEditedAndExtendedWords()
    {
        Assert.Equal(["go", "teh"], TextDiff.Rebase(List, Text, Text.Replace("recieved", "received", StringComparison.Ordinal)).Select(s => s.Original));
        Assert.Equal(["go", "recieved"], TextDiff.Rebase(List, Text, Text.Replace("teh files", "tehr files", StringComparison.Ordinal)).Select(s => s.Original));
        Assert.Equal(["recieved", "teh"], TextDiff.Rebase(List, Text, Text.Replace(" go ", " ago ", StringComparison.Ordinal)).Select(s => s.Original));
    }

    [Fact]
    public void RebaseKeepsSuggestionsWhenPunctuationTypedAtBoundary()
    {
        Assert.Equal(3, TextDiff.Rebase(List, Text, Text + " Thanks").Count);
    }

    [Theory]
    [InlineData("She go home", 4, 6, "go", true)]
    [InlineData("She goes home", 4, 6, "go", false)]
    [InlineData("She ago home", 5, 7, "go", false)]
    [InlineData("Send the the report", 5, 9, "the ", true)]
    [InlineData("Hi , there", 2, 4, " ,", true)]
    [InlineData("漢字テスト", 1, 3, "字テ", true)]
    [InlineData("short", 2, 9, "ort", false)]
    public void SpanStillValid(string text, int start, int end, string expected, bool valid)
    {
        Assert.Equal(valid, TextDiff.SpanStillValid(text, start, end, expected));
    }

    [Fact]
    public void SpanValidityCanIgnoreWordBoundariesForSelections()
    {
        Assert.True(TextDiff.SpanStillValid("sentence", 1, 4, "ent", wholeWords: false));
        Assert.False(TextDiff.SpanStillValid("sentence", 1, 4, "ent"));
    }

    [Fact]
    public void LocatorFindsOccurrencesAndNearestMatch()
    {
        const string text = "the cat and the dog and the bird";
        Assert.Equal(2, TextSpanLocator.OccurrenceIndex(text, text.LastIndexOf("the", StringComparison.Ordinal), "the"));
        Assert.Equal(12, TextSpanLocator.FindNear(text, 14, "the"));
        Assert.Null(TextSpanLocator.FindNear(text, 0, "fish"));
    }

    [Theory]
    [InlineData(3, "First sentence.")]
    [InlineData(20, "The second one is here!")]
    [InlineData(46, "Third?")]
    public void SentenceAroundCaret(int caret, string expected)
    {
        const string text = "First sentence. The second one is here! Third?";
        var (start, end) = SentenceFinder.Around(text, caret);
        Assert.Equal(expected, text[start..end]);
    }

    [Fact]
    public void SentenceAroundRespectsWordParagraphMarks()
    {
        const string text = "Line one\rSecond paragraph here";
        var (start, end) = SentenceFinder.Around(text, 12);
        Assert.Equal("Second paragraph here", text[start..end]);
    }

    [Fact]
    public void WordCount()
    {
        Assert.Equal(6, WordCounter.Count("It's a test — of the counter."));
        Assert.Equal(0, WordCounter.Count("   "));
    }
}

public class SuggestionTrackerTests
{
    private static SuggestionFilters NoFilters() =>
        new(new HashSet<string>(), new HashSet<string>(), Categories.All.ToHashSet());

    [Fact]
    public void ResponsesForOlderTextAreRebased()
    {
        var tracker = new SuggestionTracker(NoFilters);
        const string sent = "I recieved it.";
        tracker.SetText(sent + " More");
        tracker.Apply(sent, Make.Response([Make.S(sent, "recieved")]));
        tracker.SetText("Yes, " + tracker.Text);
        Assert.Equal([7], tracker.Visible().Select(s => s.Offset));
        Assert.Equal(88, tracker.Score);
    }

    [Fact]
    public void AiFindingsSurviveFastChecksUntilOverlapped()
    {
        var tracker = new SuggestionTracker(NoFilters);
        const string text = "The weather are nice and she go home.";
        tracker.SetText(text);
        tracker.Apply(text, Make.Response([Make.S(text, "are", source: "ai"), Make.S(text, "go")], "full"));
        tracker.Apply(text, Make.Response([Make.S(text, "go")]));
        Assert.Equal(["are", "go"], tracker.Visible().Select(s => s.Original));
        var lt = Make.S(text, "are") with { Id = "lt-are" };
        tracker.Apply(text, Make.Response([lt]));
        Assert.Equal(["lt-are"], tracker.Visible().Select(s => s.Id));
    }

    [Fact]
    public void FiltersIgnoredRulesCategoriesAndDictionary()
    {
        var filters = new SuggestionFilters(
            new HashSet<string> { "kubectl" },
            new HashSet<string> { "NOISY" },
            Categories.All.Where(c => c != Categories.Style).ToHashSet());
        var tracker = new SuggestionTracker(() => filters);
        const string text = "Run kubectl now gonna go teh";
        tracker.SetText(text);
        tracker.Apply(text, Make.Response([
            Make.S(text, "kubectl", category: Categories.Spelling),
            Make.S(text, "now", rule: "NOISY"),
            Make.S(text, "gonna", category: Categories.Style),
            Make.S(text, "go"),
            Make.S(text, "teh", category: Categories.Spelling),
        ]));
        Assert.Equal(["go", "teh"], tracker.Visible().Select(s => s.Original));
        tracker.Ignore(tracker.Visible()[0]);
        Assert.Equal(["teh"], tracker.Visible().Select(s => s.Original));
    }

    [Fact]
    public void ClearingTheFieldClearsState()
    {
        var tracker = new SuggestionTracker(NoFilters);
        tracker.SetText("teh");
        tracker.Apply("teh", Make.Response([Make.S("teh", "teh")]));
        var changes = 0;
        tracker.Changed += (_, _) => changes++;
        tracker.SetText("  ");
        Assert.Empty(tracker.Visible());
        Assert.Null(tracker.Score);
        Assert.Equal(1, changes);
    }
}
