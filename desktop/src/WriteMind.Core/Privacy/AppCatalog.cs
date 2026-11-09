namespace WriteMind.Core.Privacy;

public enum AppKind
{
    Supported, // first-class integrations
    Generic,   // any other app exposing editable UI Automation text (opt-out per app)
    Browser,   // handled by the Chrome extension; skipped to avoid double underlines
    Blocked,   // never read: password managers, terminals, remote desktops, IDEs
}

public sealed record AppProfile(string ProcessName, string DisplayName, AppKind Kind, string AppId);

/// <summary>Known Windows applications and how WriteMind treats them.</summary>
public sealed class AppCatalog
{
    private static readonly Dictionary<string, AppProfile> Known = new(StringComparer.OrdinalIgnoreCase)
    {
        ["winword.exe"] = new("winword.exe", "Microsoft Word", AppKind.Supported, "word"),
        ["outlook.exe"] = new("outlook.exe", "Outlook (classic)", AppKind.Supported, "outlook"),
        ["olk.exe"] = new("olk.exe", "Outlook", AppKind.Supported, "outlook"),
        ["notepad.exe"] = new("notepad.exe", "Notepad", AppKind.Supported, "notepad"),
        ["whatsapp.exe"] = new("whatsapp.exe", "WhatsApp", AppKind.Supported, "whatsapp"),
        ["whatsapp.root.exe"] = new("whatsapp.root.exe", "WhatsApp", AppKind.Supported, "whatsapp"),
        ["wordpad.exe"] = new("wordpad.exe", "WordPad", AppKind.Supported, "wordpad"),
        ["onenote.exe"] = new("onenote.exe", "OneNote", AppKind.Supported, "onenote"),
        ["powerpnt.exe"] = new("powerpnt.exe", "PowerPoint", AppKind.Supported, "powerpoint"),
        ["ms-teams.exe"] = new("ms-teams.exe", "Microsoft Teams", AppKind.Supported, "teams"),
        ["slack.exe"] = new("slack.exe", "Slack", AppKind.Supported, "slack"),
        ["telegram.exe"] = new("telegram.exe", "Telegram", AppKind.Supported, "telegram"),

        ["chrome.exe"] = new("chrome.exe", "Google Chrome", AppKind.Browser, "browser"),
        ["msedge.exe"] = new("msedge.exe", "Microsoft Edge", AppKind.Browser, "browser"),
        ["brave.exe"] = new("brave.exe", "Brave", AppKind.Browser, "browser"),
        ["firefox.exe"] = new("firefox.exe", "Firefox", AppKind.Browser, "browser"),
        ["opera.exe"] = new("opera.exe", "Opera", AppKind.Browser, "browser"),
        ["vivaldi.exe"] = new("vivaldi.exe", "Vivaldi", AppKind.Browser, "browser"),
    };

    private static readonly HashSet<string> Blocked = new(StringComparer.OrdinalIgnoreCase)
    {
        // Password managers and credential UIs
        "keepass.exe", "keepassxc.exe", "1password.exe", "bitwarden.exe", "lastpass.exe", "dashlane.exe",
        "credentialuibroker.exe", "consent.exe", "logonui.exe", "lockapp.exe",
        // Terminals and shells
        "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe", "openconsole.exe",
        "putty.exe", "mintty.exe", "wsl.exe", "alacritty.exe", "wezterm-gui.exe",
        // Remote desktops and virtualisation (keystrokes belong to another machine)
        "mstsc.exe", "msrdc.exe", "vmconnect.exe", "anydesk.exe", "teamviewer.exe", "vmware.exe", "virtualbox.exe",
        // Code editors and IDEs (code is not prose)
        "devenv.exe", "code.exe", "rider64.exe", "idea64.exe", "pycharm64.exe", "notepad++.exe", "sublime_text.exe",
        // Banking/crypto wallets commonly used on desktop
        "exodus.exe", "ledger live.exe",
    };

    private readonly HashSet<string> _extraBlocked;

    /// <param name="extraBlocked">Additional process names the user never wants WriteMind to read.</param>
    public AppCatalog(IEnumerable<string>? extraBlocked = null)
    {
        _extraBlocked = new HashSet<string>((extraBlocked ?? []).Select(NormaliseProcessName), StringComparer.OrdinalIgnoreCase);
    }

    public AppProfile Resolve(string processName)
    {
        var name = NormaliseProcessName(processName);
        if (Blocked.Contains(name) || _extraBlocked.Contains(name)) return new AppProfile(name, name, AppKind.Blocked, "blocked");
        if (Known.TryGetValue(name, out var profile)) return profile;
        return new AppProfile(name, Path.GetFileNameWithoutExtension(name), AppKind.Generic, "generic");
    }

    public IEnumerable<AppProfile> SupportedApps() =>
        Known.Values.Where(a => a.Kind == AppKind.Supported && !_extraBlocked.Contains(a.ProcessName)).DistinctBy(a => a.DisplayName);

    public static string NormaliseProcessName(string processName)
    {
        var trimmed = processName.Trim();
        var cut = trimmed.LastIndexOfAny(['\\', '/']);
        var name = (cut >= 0 ? trimmed[(cut + 1)..] : trimmed).ToLowerInvariant();
        return name.EndsWith(".exe", StringComparison.Ordinal) ? name : name + ".exe";
    }
}
