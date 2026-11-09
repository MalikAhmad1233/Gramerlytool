using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using WriteMind.Core.Api;

namespace WriteMind.Core.Tests;

internal sealed class MemorySessions : ISessionStore
{
    public AuthSession? Session { get; set; }
    public AuthSession? Load() => Session;
    public void Save(AuthSession? session) => Session = session;
}

internal sealed class StubHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, string?, HttpResponseMessage> _respond;
    public List<(HttpRequestMessage Request, string? Body)> Calls { get; } = [];

    public StubHandler(Func<HttpRequestMessage, string?, HttpResponseMessage> respond) => _respond = respond;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        Calls.Add((request, body));
        return _respond(request, body);
    }

    public static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}

public class ApiClientTests
{
    private static readonly string FixtureDir = Path.Combine(AppContext.BaseDirectory, "fixtures");

    private static string TokenJson(string access, string refresh) =>
        $$$"""
        {"access_token":"{{{access}}}","refresh_token":"{{{refresh}}}","token_type":"bearer","expires_in":900,
         "user":{"id":"7f9c24e5-1111-4d4c-9b1e-1a2b3c4d5e6f","email":"ada@example.com","display_name":"Ada","plan":"free","created_at":"2026-01-01T00:00:00Z"}}
        """;

    [Fact]
    public async Task CheckSerialisesSnakeCaseAndParsesTheRealFixture()
    {
        var fixture = File.ReadAllText(Path.Combine(FixtureDir, "check-response.json"));
        var response = JsonDocument.Parse(fixture).RootElement.GetProperty("response").GetRawText();
        var handler = new StubHandler((_, _) => StubHandler.Json(HttpStatusCode.OK, response));
        using var client = new WriteMindApiClient(new Uri("http://api.test"), new MemorySessions(), handler);

        var result = await client.CheckAsync(new CheckRequest
        {
            Text = "teh", Style = "formal", Mode = "full", DisabledRules = ["R1"],
            Client = new ClientContext("windows-desktop", "word"),
        }, TestContext.Current.CancellationToken);

        var body = JsonDocument.Parse(handler.Calls[0].Body!).RootElement;
        Assert.Equal("/v1/check", handler.Calls[0].Request.RequestUri!.AbsolutePath);
        Assert.Equal("full", body.GetProperty("mode").GetString());
        Assert.Equal("word", body.GetProperty("client").GetProperty("app").GetString());
        Assert.Equal("windows-desktop", body.GetProperty("client").GetProperty("kind").GetString());
        Assert.Equal("R1", body.GetProperty("disabled_rules")[0].GetString());
        Assert.False(body.TryGetProperty("categories", out _)); // null omitted → server default
        Assert.Null(handler.Calls[0].Request.Headers.Authorization);

        Assert.NotEmpty(result.Suggestions);
        Assert.Equal("ok", result.Engine.Languagetool);
        Assert.InRange(result.Stats.Score, 0, 100);
    }

    [Fact]
    public void FixtureOffsetsAreUtf16AndSliceDotNetStrings()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(FixtureDir, "check-response.json")));
        var text = doc.RootElement.GetProperty("request").GetProperty("text").GetString()!;
        var response = doc.RootElement.GetProperty("response").Deserialize<CheckResponse>(Json.Options)!;
        foreach (var s in response.Suggestions)
            Assert.Equal(s.Original, text.Substring(s.Offset, s.Length));
        Assert.True(text.IndexOf("👋", StringComparison.Ordinal) < response.Suggestions[0].Offset);
    }

    [Fact]
    public async Task ErrorsMapToTypedExceptions()
    {
        var handler = new StubHandler((_, _) => StubHandler.Json((HttpStatusCode)413,
            """{"error":{"code":"text_too_long","message":"Text exceeds 20000 characters.","request_id":"abc"}}"""));
        using var client = new WriteMindApiClient(new Uri("http://api.test"), new MemorySessions(), handler);
        var ex = await Assert.ThrowsAsync<WriteMindApiException>(() => client.CheckAsync(new CheckRequest { Text = "x" }, TestContext.Current.CancellationToken));
        Assert.Equal("text_too_long", ex.Code);
        Assert.Equal((HttpStatusCode)413, ex.Status);
        Assert.False(ex.IsOffline);
    }

    [Fact]
    public async Task UnreachableServerIsReportedAsOffline()
    {
        var handler = new StubHandler((_, _) => throw new HttpRequestException("connection refused"));
        using var client = new WriteMindApiClient(new Uri("http://api.test"), new MemorySessions(), handler);
        var ex = await Assert.ThrowsAsync<WriteMindApiException>(() => client.MetaAsync(TestContext.Current.CancellationToken));
        Assert.True(ex.IsOffline);
    }

    [Fact]
    public async Task LoginStoresSessionAndAuthorisesLaterCalls()
    {
        var sessions = new MemorySessions();
        var handler = new StubHandler((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/v1/auth/login" => StubHandler.Json(HttpStatusCode.OK, TokenJson("A1", "R1")),
            "/v1/dictionary" => StubHandler.Json(HttpStatusCode.OK, """{"words":["Kubernetes"],"count":1,"limit":5000}"""),
            _ => new HttpResponseMessage(HttpStatusCode.NotFound),
        });
        using var client = new WriteMindApiClient(new Uri("http://api.test"), sessions, handler);
        var changed = 0;
        client.SessionChanged += (_, _) => changed++;
        var user = await client.LoginAsync("ada@example.com", "pw", TestContext.Current.CancellationToken);
        Assert.Equal("Ada", user.DisplayName);
        Assert.Equal("R1", sessions.Session?.RefreshToken);
        Assert.Equal(1, changed);

        var dict = await client.GetDictionaryAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["Kubernetes"], dict.Words);
        Assert.Equal("Bearer A1", handler.Calls[^1].Request.Headers.Authorization?.ToString());
    }

    [Fact]
    public async Task ExpiredAccessTokenIsRefreshedOnceThenRetried()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-09T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var user = new UserInfo(Guid.NewGuid(), "ada@example.com", "Ada", "free", time.GetUtcNow());
        var sessions = new MemorySessions { Session = new AuthSession("OLD", "R1", time.GetUtcNow().AddMinutes(10), user) };
        var handler = new StubHandler((req, body) =>
        {
            if (req.RequestUri!.AbsolutePath == "/v1/auth/refresh")
                return body!.Contains("\"R1\"", StringComparison.Ordinal)
                    ? StubHandler.Json(HttpStatusCode.OK, TokenJson("NEW", "R2"))
                    : StubHandler.Json(HttpStatusCode.Unauthorized, """{"error":{"code":"invalid_refresh_token","message":"x"}}""");
            return req.Headers.Authorization?.Parameter == "NEW"
                ? StubHandler.Json(HttpStatusCode.OK, """{"words":[],"count":0,"limit":5000}""")
                : StubHandler.Json(HttpStatusCode.Unauthorized, """{"error":{"code":"invalid_token","message":"expired"}}""");
        });
        using var client = new WriteMindApiClient(new Uri("http://api.test"), sessions, handler, time);

        await client.GetDictionaryAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["/v1/dictionary", "/v1/auth/refresh", "/v1/dictionary"], handler.Calls.Select(c => c.Request.RequestUri!.AbsolutePath));
        Assert.Equal("R2", sessions.Session?.RefreshToken);
    }

    [Fact]
    public async Task RejectedRefreshSignsOutAndFallsBackToGuest()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var user = new UserInfo(Guid.NewGuid(), "ada@example.com", null, "free", time.GetUtcNow());
        var sessions = new MemorySessions { Session = new AuthSession("OLD", "R-dead", time.GetUtcNow().AddSeconds(5), user) };
        var handler = new StubHandler((req, _) => req.RequestUri!.AbsolutePath == "/v1/auth/refresh"
            ? StubHandler.Json(HttpStatusCode.Unauthorized, """{"error":{"code":"invalid_refresh_token","message":"x"}}""")
            : StubHandler.Json(HttpStatusCode.OK, """{"name":"WriteMind AI","version":"1.0.0","ai_available":false,"offsets":"utf-16"}"""));
        using var client = new WriteMindApiClient(new Uri("http://api.test"), sessions, handler, time);

        var check = await Assert.ThrowsAsync<WriteMindApiException>(() => client.GetSettingsAsync(TestContext.Current.CancellationToken));
        Assert.Null(sessions.Session);
        Assert.Null(client.CurrentUser);
        Assert.Equal("unauthorized", (await Assert.ThrowsAsync<WriteMindApiException>(() => client.UsageAsync(7, TestContext.Current.CancellationToken))).Code);
        Assert.NotNull(check);
    }
}

/// <summary>Talks to a real WriteMind API (skipped when none is running at WRITEMIND_API_URL).</summary>
public class LiveApiTests
{
    private static readonly Uri BaseUrl = new(Environment.GetEnvironmentVariable("WRITEMIND_API_URL") ?? "http://localhost:8000");

    private static bool Reachable()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            return http.GetAsync(new Uri(BaseUrl, "/health")).GetAwaiter().GetResult().IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException)
        {
            return false;
        }
    }

    [Fact]
    public async Task EndToEndCheckRewriteAndAccount()
    {
        Assert.SkipUnless(Reachable(), $"No WriteMind API at {BaseUrl}");
        var ct = TestContext.Current.CancellationToken;
        using var client = new WriteMindApiClient(BaseUrl, new MemorySessions());

        const string text = "Hi 👋 She go to school and I recieved teh files.";
        var check = await client.CheckAsync(new CheckRequest { Text = text, Client = new ClientContext("windows-desktop", "word") }, ct);
        Assert.Contains(check.Suggestions, s => s.Original == "teh" && s.Replacements.Contains("the"));
        foreach (var s in check.Suggestions) Assert.Equal(s.Original, text.Substring(s.Offset, s.Length));

        var rewrite = await client.RewriteAsync(new RewriteRequest { Text = "hey can u send me the report asap", Style = "formal" }, ct);
        Assert.Equal("Hello, can you send me the report as soon as possible?", rewrite.Alternatives[0].Text);

        var email = $"desktop-{Guid.NewGuid():N}@example.com";
        await client.RegisterAsync(email, "Writer#2026", "Desktop Tester", ct);
        await client.AddWordAsync("Ahmadzai", ct);
        var settings = await client.PutSettingsAsync(new { default_style = "formal", disabled_apps = new[] { "slack.exe" } }, ct);
        Assert.Equal("formal", settings.DefaultStyle);
        Assert.Contains("slack.exe", settings.DisabledApps);
        var withDictionary = await client.CheckAsync(new CheckRequest { Text = "Ahmadzai recieved it." }, ct);
        Assert.DoesNotContain(withDictionary.Suggestions, s => s.Original == "Ahmadzai");
        await client.SendFeedbackAsync([new FeedbackEvent("MORFOLOGIK_RULE_EN_US", "spelling", "languagetool", "accepted")], ct);
        var usage = await client.UsageAsync(7, ct);
        Assert.True(usage.Totals?.Checks >= 1);
        await client.LogoutAsync(ct);
        Assert.Null(client.CurrentUser);
    }
}
