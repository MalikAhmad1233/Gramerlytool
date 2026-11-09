using System.Windows.Interop;
using Microsoft.Win32;
using WriteMind.Core.Api;
using WriteMind.Core.Settings;
using WriteMind.Desktop.Interop;

namespace WriteMind.Desktop.Services;

/// <summary>Keeps local settings and the account in sync (same model as the Chrome extension).</summary>
internal static class SyncService
{
    public static async Task PullAsync(SettingsStore settings, WriteMindApiClient api)
    {
        if (api.CurrentUser is null) return;
        var remote = await api.GetSettingsAsync();
        var dictionary = await api.GetDictionaryAsync();
        var local = settings.Current;
        foreach (var word in local.Dictionary.Where(w => !dictionary.Words.Contains(w, StringComparer.OrdinalIgnoreCase)))
            await api.AddWordAsync(word);
        settings.Update(c => c with
        {
            Language = remote.Language,
            Style = remote.DefaultStyle,
            AiEnabled = remote.AiEnabled,
            Categories = remote.EnabledCategories,
            DisabledRules = c.DisabledRules.Union(remote.DisabledRules).ToList(),
            DisabledApps = c.DisabledApps.Union(remote.DisabledApps, StringComparer.OrdinalIgnoreCase).ToList(),
            Dictionary = c.Dictionary.Union(dictionary.Words, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToList(),
        });
    }

    public static async Task PushAsync(SettingsStore settings, WriteMindApiClient api)
    {
        if (api.CurrentUser is null) return;
        var s = settings.Current;
        await api.PutSettingsAsync(new
        {
            language = s.Language,
            default_style = s.Style,
            ai_enabled = s.AiEnabled,
            enabled_categories = s.Categories,
            disabled_rules = s.DisabledRules,
            disabled_apps = s.DisabledApps,
        });
        foreach (var word in s.Dictionary) await api.AddWordAsync(word);
    }
}

/// <summary>"Start with Windows" via the per-user Run key (no admin rights needed).</summary>
internal static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "WriteMind AI";

    public static void Apply(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        if (key is null) return;
        if (enabled && Environment.ProcessPath is { } path) key.SetValue(ValueName, $"\"{path}\" --background");
        else key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}

/// <summary>
/// One global shortcut (Ctrl+Alt+W) via RegisterHotKey. Windows delivers only that combination to us —
/// this is not a keyboard hook and sees no other keys.
/// </summary>
internal sealed class HotkeyService : IDisposable
{
    private const int HotkeyId = 0x5741; // "WA"
    private readonly HwndSource _source;
    private readonly Action _onHotkey;

    public HotkeyService(Action onHotkey)
    {
        _onHotkey = onHotkey;
        _source = new HwndSource(new HwndSourceParameters("WriteMindHotkeys") { Width = 0, Height = 0, WindowStyle = 0 });
        _source.AddHook(WndProc);
        Registered = NativeMethods.RegisterHotKey(_source.Handle, HotkeyId,
            NativeMethods.MOD_CONTROL | NativeMethods.MOD_ALT | NativeMethods.MOD_NOREPEAT, 'W');
    }

    public bool Registered { get; }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == NativeMethods.WM_HOTKEY && wParam.ToInt32() == HotkeyId)
        {
            _onHotkey();
            handled = true;
        }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        NativeMethods.UnregisterHotKey(_source.Handle, HotkeyId);
        _source.RemoveHook(WndProc);
        _source.Dispose();
    }
}
