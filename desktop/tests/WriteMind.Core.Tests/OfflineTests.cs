using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using WriteMind.Core.Api;
using WriteMind.Core.Offline;

namespace WriteMind.Core.Tests;

public class OfflineEngineTests
{
    private static readonly string Fixtures = Path.Combine(AppContext.BaseDirectory, "fixtures");
    private static readonly Speller Us = Speller.For("en-US")!;

    private static CheckResponse Check(string text, string style = "neutral", string? app = null, IReadOnlyList<string>? dictionary = null) =>
        OfflineEngine.Check(text, new OfflineOptions("en-US", style, app, "fast", dictionary), Us);

    private static bool Fixes(string bad, string good, string style = "neutral") =>
        Check(bad, style).Suggestions.Any(s => s.Replacements.Any(r => bad[..s.Offset] + r + bad[(s.Offset + s.Length)..] == good));

    private static JsonDocument Fixture(string name) => JsonDocument.Parse(File.ReadAllText(Path.Combine(Fixtures, name)));

    public static TheoryData<int> ParityCases()
    {
        using var doc = Fixture("offline-parity.json");
        var data = new TheoryData<int>();
        for (var i = 0; i < doc.RootElement.GetProperty("cases").GetArrayLength(); i++) data.Add(i);
        return data;
    }

    [Theory]
    [MemberData(nameof(ParityCases))]
    public void MatchesTheChromeExtensionExactly(int index)
    {
        using var doc = Fixture("offline-parity.json");
        var c = doc.RootElement.GetProperty("cases")[index];
        var text = c.GetProperty("text").GetString()!;
        var app = c.GetProperty("app").ValueKind == JsonValueKind.Null ? null : c.GetProperty("app").GetString();
        var expected = c.GetProperty("suggestions").EnumerateArray().Select(s =>
            $"{s.GetProperty("offset").GetInt32()}+{s.GetProperty("length").GetInt32()} {s.GetProperty("rule").GetString()} " +
            (s.GetProperty("replacement").ValueKind == JsonValueKind.Null ? "-" : s.GetProperty("replacement").GetString())).ToList();
        var actual = Check(text, c.GetProperty("style").GetString()!, app).Suggestions.Select(s =>
            $"{s.Offset}+{s.Length} {s.RuleId} {(s.RuleId == "WM_SPELLING" ? "-" : s.Replacements[0])}").ToList();
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void AccuracyFixtureAndHeldOutSentences()
    {
        using var accuracy = Fixture("accuracy-en.json");
        using var heldout = Fixture("offline-heldout.json");
        foreach (var c in accuracy.RootElement.GetProperty("errors").EnumerateArray())
        {
            var text = c.GetProperty("text").GetString()!;
            var original = c.GetProperty("original").GetString()!;
            var replacement = c.GetProperty("replacement").GetString()!;
            var targets = new List<string>();
            for (var i = text.IndexOf(original, StringComparison.Ordinal); i >= 0; i = text.IndexOf(original, i + 1, StringComparison.Ordinal))
                targets.Add(text[..i] + replacement + text[(i + original.Length)..]);
            Assert.True(targets.Any(t => Fixes(text, t)), text);
        }
        foreach (var e in heldout.RootElement.GetProperty("errors").EnumerateArray())
            Assert.True(Fixes(e[0].GetString()!, e[1].GetString()!), e[0].GetString());
        foreach (var t in accuracy.RootElement.GetProperty("clean").EnumerateArray().Concat(heldout.RootElement.GetProperty("clean").EnumerateArray()))
            Assert.Empty(Check(t.GetString()!).Suggestions);
        foreach (var t in heldout.RootElement.GetProperty("chatClean").EnumerateArray())
            Assert.Empty(Check(t.GetString()!, app: "whatsapp").Suggestions);
    }

    [Fact]
    public void OffsetsAreUtf16AndSpellingRanksTheLikelyWordFirst()
    {
        const string text = "Great news 😀 — I recieved teh files and its a great day.";
        var r = Check(text);
        foreach (var s in r.Suggestions) Assert.Equal(s.Original, text.Substring(s.Offset, s.Length));
        Assert.Equal(["recieved", "teh", "its"], r.Suggestions.Select(s => s.Original));
        Assert.Equal("the", r.Suggestions[1].Replacements[0]);
        Assert.Equal("builtin", r.Engine.Languagetool);
    }

    [Theory]
    [InlineData("This is a apple.", "This is an apple.")]
    [InlineData("It took a hour.", "It took an hour.")]
    [InlineData("She is an university student.", "She is a university student.")]
    [InlineData("He has an MBA and a FBI badge.", "He has an MBA and an FBI badge.")]
    public void ArticleAgreement(string bad, string good) => Assert.True(Fixes(bad, good));

    [Fact]
    public void IgnoresTechnicalTokensAndHonoursDictionary()
    {
        Assert.Empty(Check("Mail teh.team@exmaple.com or see https://exmaple.com/teh, ping @johnsmyth, run `npm instal`, use WriteMind.").Suggestions);
        Assert.Empty(Check("Our Zorblax rollout is done, and zorblax works.", dictionary: ["zorblax"]).Suggestions);
    }

    [Fact]
    public void RegisterAndChatProfiles()
    {
        const string text = "Hey, I'm gonna send u the report asap!!!";
        var formal = Check(text, "formal").Suggestions.Select(s => s.RuleId).ToList();
        Assert.Contains("WM_FORMAL_CONTRACTION", formal);
        Assert.Contains("WM_INFORMAL_WORD", formal);
        Assert.DoesNotContain("WM_INFORMAL_WORD", Check(text).Suggestions.Select(s => s.RuleId));
        Assert.Equal(["It has", "It is"], Check("It's been great.", "formal").Suggestions.Single(s => s.RuleId == "WM_FORMAL_CONTRACTION").Replacements);
        Assert.Empty(Check("hey are you coming tonight", app: "whatsapp").Suggestions);
    }

    [Fact]
    public void BritishDictionary()
    {
        var gb = Speller.For("en-GB")!;
        Assert.Empty(OfflineEngine.Check("The colour of the organisation logo.", new OfflineOptions("en-GB", "neutral", null), gb).Suggestions);
        Assert.Equal(["colour"], Check("The colour of the logo.").Suggestions.Select(s => s.Original));
        Assert.Null(Speller.For("de-DE"));
    }

    [Fact]
    public void FastOnLongDocuments()
    {
        var text = string.Concat(Enumerable.Repeat("She go to school and I recieved teh files. It seem fine. ", 300));
        Check(text); // warm up
        var watch = System.Diagnostics.Stopwatch.StartNew();
        Assert.Equal(1200, Check(text).Suggestions.Count);
        Assert.True(watch.ElapsedMilliseconds < 1500, $"{watch.ElapsedMilliseconds} ms");
    }

    [Fact]
    public void RewriteMatchesTheExtension()
    {
        Assert.Equal("I am sure it is fine, do not worry", OfflineRewriter.ExpandContractions("I'm sure it's fine, don't worry"));
        Assert.Equal("I'm sure that it's fine; don't worry", OfflineRewriter.Contract("I am sure that it is fine; do not worry"));
        Assert.Equal("Hello, I just wanted to say thank you.", OfflineRewriter.Transform("hey i just wanted to say thanks", "formal"));
        Assert.Equal("To decide, we can meet.", OfflineRewriter.Transform("In order to make a decision, we are able to meet", "concise"));
        Assert.Equal("I'm sure we'll help you.", OfflineRewriter.Transform("I am sure we will assist you", "casual"));
        Assert.Equal("Hello John, thank you.", OfflineRewriter.Transform("Hi John, thanks", "formal"));
        Assert.Equal("What time works for you?", OfflineRewriter.Transform("what time works for you", "professional"));
        var r = OfflineRewriter.Rewrite("hey can u send me the report asap", "formal", 2, "en-US", Us);
        Assert.Equal("Hello, can you send me the report as soon as possible?", r.Alternatives[0].Text);
        var fixedText = OfflineRewriter.Rewrite("She go to school every day", "professional", 3, "en-US", Us);
        Assert.Equal("She goes to school every day.", fixedText.Alternatives[0].Text);
    }
}

public class HybridCheckerTests
{
    [Fact]
    public async Task FallsBackToBuiltInCheckerWhenTheServerIsUnreachableAndRetriesLater()
    {
        var calls = 0;
        var serverUp = false;
        var handler = new StubHandler((req, _) =>
        {
            calls++;
            if (!serverUp) throw new HttpRequestException("connection refused");
            return StubHandler.Json(HttpStatusCode.OK, File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "check-response.json"))
                .Split("\"response\":", 2)[1].TrimEnd().TrimEnd('}').TrimEnd());
        });
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        using var api = new WriteMindApiClient(new Uri("http://localhost:9"), new MemorySessions(), handler, time);
        var hybrid = new HybridChecker(api, time);
        var request = new CheckRequest { Text = "She go to school and I recieved teh files." };

        var offline = await hybrid.CheckAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal("builtin", offline.Engine.Languagetool);
        Assert.Equal(["go", "recieved", "teh"], offline.Suggestions.Select(s => s.Original));
        Assert.False(hybrid.UsingServer);

        await hybrid.CheckAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal(1, calls); // within the retry window: no second network attempt

        serverUp = true;
        time.Advance(TimeSpan.FromSeconds(31));
        var online = await hybrid.CheckAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal("ok", online.Engine.Languagetool);
        Assert.True(hybrid.UsingServer);

        var rewrite = await new HybridChecker(new WriteMindApiClient(new Uri("http://localhost:9"), new MemorySessions(),
            new StubHandler((_, _) => throw new HttpRequestException("down")))).RewriteAsync(
            new RewriteRequest { Text = "hey can u send me the report asap", Style = "formal" }, TestContext.Current.CancellationToken);
        Assert.Equal("Hello, can you send me the report as soon as possible?", rewrite.Alternatives[0].Text);
    }
}
