using Microsoft.Extensions.Time.Testing;
using WriteMind.Core.Privacy;
using WriteMind.Core.Scheduling;
using WriteMind.Core.Settings;

namespace WriteMind.Core.Tests;

public class SensitiveFieldPolicyTests
{
    private static readonly AppCatalog Catalog = new();
    private static readonly IReadOnlySet<string> None = new HashSet<string>();

    private static FieldDescriptor Field(string process = "WINWORD.EXE") => new()
    {
        ProcessName = process,
        ControlType = "Document",
        HasTextPattern = true,
    };

    [Fact]
    public void WordDocumentIsEligible() =>
        Assert.Equal(FieldDecision.Eligible, SensitiveFieldPolicy.Evaluate(Field(), Catalog, None));

    [Fact]
    public void PasswordFieldsAreNeverRead() =>
        Assert.Equal(FieldDecision.Password, SensitiveFieldPolicy.Evaluate(Field() with { IsPassword = true }, Catalog, None));

    [Theory]
    [InlineData("KeePass.exe")]
    [InlineData("1Password.exe")]
    [InlineData("WindowsTerminal.exe")]
    [InlineData("mstsc.exe")]
    [InlineData("Code.exe")]
    public void BlockedAppsAreNeverRead(string process) =>
        Assert.Equal(FieldDecision.BlockedApp, SensitiveFieldPolicy.Evaluate(Field(process), Catalog, None));

    [Theory]
    [InlineData("chrome.exe")]
    [InlineData("msedge")]
    public void BrowsersAreLeftToTheExtension(string process) =>
        Assert.Equal(FieldDecision.BrowserHandledByExtension, SensitiveFieldPolicy.Evaluate(Field(process), Catalog, None));

    [Theory]
    [InlineData("Enter PIN", "")]
    [InlineData("", "txtPassword")]
    [InlineData("Card number", "")]
    [InlineData("One-time code", "")]
    [InlineData("API key", "")]
    public void SensitiveNamesAreSkipped(string name, string automationId) =>
        Assert.Equal(FieldDecision.SensitiveName,
            SensitiveFieldPolicy.Evaluate(Field("notepad.exe") with { Name = name, AutomationId = automationId, ControlType = "Edit" }, Catalog, None));

    [Fact]
    public void OwnWindowsReadOnlyAndUserDisabledAppsAreSkipped()
    {
        Assert.Equal(FieldDecision.OwnWindow, SensitiveFieldPolicy.Evaluate(Field() with { IsOwnProcess = true }, Catalog, None));
        Assert.Equal(FieldDecision.NotEditable, SensitiveFieldPolicy.Evaluate(Field() with { IsReadOnly = true }, Catalog, None));
        Assert.Equal(FieldDecision.NotEditable, SensitiveFieldPolicy.Evaluate(Field() with { HasTextPattern = false }, Catalog, None));
        Assert.Equal(FieldDecision.NotEditable, SensitiveFieldPolicy.Evaluate(Field() with { ControlType = "Button" }, Catalog, None));
        Assert.Equal(FieldDecision.DisabledByUser, SensitiveFieldPolicy.Evaluate(Field("Outlook.exe"), Catalog, new HashSet<string> { "outlook.exe" }));
    }

    [Fact]
    public void CatalogResolvesKnownGenericAndUserBlockedApps()
    {
        var catalog = new AppCatalog(["Slack"]);
        Assert.Equal(AppKind.Supported, catalog.Resolve(@"C:\Program Files\Microsoft Office\WINWORD.EXE").Kind);
        Assert.Equal("whatsapp", catalog.Resolve("WhatsApp.Root.exe").AppId);
        Assert.Equal(AppKind.Generic, catalog.Resolve("someeditor").Kind);
        Assert.Equal(AppKind.Blocked, catalog.Resolve("slack.exe").Kind);
        Assert.DoesNotContain(catalog.SupportedApps(), a => a.ProcessName == "slack.exe");
        Assert.Contains(catalog.SupportedApps(), a => a.DisplayName == "Microsoft Word");
    }
}

public class SchedulerTests
{
    [Fact]
    public void DebouncesFastAndFullChecks()
    {
        var time = new FakeTimeProvider();
        var runs = new List<string>();
        using var scheduler = new CheckScheduler(m => runs.Add(m), () => true, time,
            TimeSpan.FromMilliseconds(300), TimeSpan.FromMilliseconds(1000));
        scheduler.Poke();
        time.Advance(TimeSpan.FromMilliseconds(200));
        scheduler.Poke(); // still typing
        time.Advance(TimeSpan.FromMilliseconds(299));
        Assert.Empty(runs);
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(["fast"], runs);
        time.Advance(TimeSpan.FromMilliseconds(700));
        Assert.Equal(["fast", "full"], runs);
    }

    [Fact]
    public void SkipsFullChecksWhenAiIsOffAndCancels()
    {
        var time = new FakeTimeProvider();
        var runs = new List<string>();
        using var scheduler = new CheckScheduler(m => runs.Add(m), () => false, time);
        scheduler.Poke(immediate: true);
        time.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal(["fast"], runs);
        scheduler.Poke();
        scheduler.Cancel();
        time.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal(["fast"], runs);
    }
}

public class SettingsStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "wm-tests-" + Guid.NewGuid().ToString("N"));

    private sealed class XorProtector : ISecretProtector
    {
        public byte[] Protect(byte[] plain) => plain.Select(b => (byte)(b ^ 0x5A)).ToArray();
        public byte[] Unprotect(byte[] cipher) => Protect(cipher);
    }

    [Fact]
    public void SettingsRoundTripAndRaiseChanged()
    {
        var store = new SettingsStore(_dir, new XorProtector());
        Assert.Equal("neutral", store.Current.Style);
        AppSettings? seen = null;
        store.Changed += (_, s) => seen = s;
        store.Update(s => s with { Style = "formal", Dictionary = ["Kubernetes"], DisabledApps = ["Slack"] });
        Assert.Equal("formal", seen?.Style);

        var reloaded = new SettingsStore(_dir, new XorProtector());
        Assert.Equal("formal", reloaded.Current.Style);
        Assert.Equal(["Kubernetes"], reloaded.Current.Dictionary);
        Assert.Contains("slack.exe", reloaded.Current.DisabledAppSet());
        Assert.Contains("kubernetes", reloaded.Current.ToFilters().Dictionary);
    }

    [Fact]
    public void CorruptSettingsFallBackToDefaults()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, "settings.json"), "{ not json");
        Assert.Equal(new AppSettings().ApiBaseUrl, new SettingsStore(_dir, new XorProtector()).Current.ApiBaseUrl);
    }

    [Fact]
    public void SessionIsEncryptedAtRestAndCanBeCleared()
    {
        var store = new SettingsStore(_dir, new XorProtector());
        var user = new Api.UserInfo(Guid.NewGuid(), "ada@example.com", "Ada", "free", DateTimeOffset.UtcNow);
        store.Save(new Api.AuthSession("access-token-123", "refresh-token-456", DateTimeOffset.UtcNow.AddMinutes(15), user));
        var raw = File.ReadAllText(Path.Combine(_dir, "session.bin"));
        Assert.DoesNotContain("refresh-token-456", raw, StringComparison.Ordinal);
        Assert.Equal("refresh-token-456", store.Load()?.RefreshToken);
        store.Save(null);
        Assert.Null(store.Load());
        Assert.False(File.Exists(Path.Combine(_dir, "session.bin")));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
