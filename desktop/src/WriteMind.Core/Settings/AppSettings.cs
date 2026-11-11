using System.Text.Json;
using WriteMind.Core.Api;
using WriteMind.Core.Privacy;
using WriteMind.Core.Text;

namespace WriteMind.Core.Settings;

public sealed record AppSettings
{
    public string ApiBaseUrl { get; init; } = "http://localhost:8000";
    public bool Enabled { get; init; } = true;
    public string Language { get; init; } = "en-US";
    public string Style { get; init; } = "neutral";
    public bool AiEnabled { get; init; } = true;
    public IReadOnlyList<string> Categories { get; init; } = Api.Categories.All;
    public IReadOnlyList<string> Dictionary { get; init; } = [];
    public IReadOnlyList<string> DisabledRules { get; init; } = [];
    public IReadOnlyList<string> DisabledApps { get; init; } = [];
    public bool CheckGenericApps { get; init; } = true;
    public bool StartWithWindows { get; init; } = true;
    public bool ShowUnderlines { get; init; } = true;

    /// <summary>False until the first-run welcome window has been closed.</summary>
    public bool Onboarded { get; init; }

    public SuggestionFilters ToFilters() => new(
        Dictionary.Select(w => w.ToLowerInvariant()).ToHashSet(),
        DisabledRules.ToHashSet(StringComparer.Ordinal),
        Categories.ToHashSet(StringComparer.Ordinal));

    public IReadOnlySet<string> DisabledAppSet() =>
        DisabledApps.Select(AppCatalog.NormaliseProcessName).ToHashSet(StringComparer.OrdinalIgnoreCase);
}

/// <summary>Protects secrets at rest (DPAPI on Windows). Tests use a reversible fake.</summary>
public interface ISecretProtector
{
    byte[] Protect(byte[] plain);
    byte[] Unprotect(byte[] cipher);
}

/// <summary>JSON settings in the user's profile; the auth session is stored separately and encrypted.</summary>
public sealed class SettingsStore : ISessionStore
{
    private readonly string _settingsPath;
    private readonly string _sessionPath;
    private readonly ISecretProtector _protector;
    private readonly Lock _gate = new();
    private AppSettings _current;

    public SettingsStore(string directory, ISecretProtector protector)
    {
        Directory.CreateDirectory(directory);
        _settingsPath = Path.Combine(directory, "settings.json");
        _sessionPath = Path.Combine(directory, "session.bin");
        _protector = protector;
        _current = LoadSettings();
    }

    public AppSettings Current
    {
        get { lock (_gate) return _current; }
    }

    public event EventHandler<AppSettings>? Changed;

    public AppSettings Update(Func<AppSettings, AppSettings> change)
    {
        AppSettings next;
        lock (_gate)
        {
            next = change(_current);
            _current = next;
            WriteAtomic(_settingsPath, JsonSerializer.SerializeToUtf8Bytes(next, Json.Options));
        }
        Changed?.Invoke(this, next);
        return next;
    }

    private AppSettings LoadSettings()
    {
        try
        {
            if (File.Exists(_settingsPath))
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllBytes(_settingsPath), Json.Options) ?? new AppSettings();
        }
        catch (JsonException)
        {
            // Corrupt file: fall back to defaults rather than crash at startup.
        }
        return new AppSettings();
    }

    public AuthSession? Load()
    {
        try
        {
            if (!File.Exists(_sessionPath)) return null;
            var plain = _protector.Unprotect(File.ReadAllBytes(_sessionPath));
            return JsonSerializer.Deserialize<AuthSession>(plain, Json.Options);
        }
        catch (Exception ex) when (ex is JsonException or IOException or System.Security.Cryptography.CryptographicException)
        {
            return null;
        }
    }

    public void Save(AuthSession? session)
    {
        lock (_gate)
        {
            if (session is null)
            {
                if (File.Exists(_sessionPath)) File.Delete(_sessionPath);
                return;
            }
            WriteAtomic(_sessionPath, _protector.Protect(JsonSerializer.SerializeToUtf8Bytes(session, Json.Options)));
        }
    }

    private static void WriteAtomic(string path, byte[] bytes)
    {
        var temp = path + ".tmp";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, path, overwrite: true);
    }
}
