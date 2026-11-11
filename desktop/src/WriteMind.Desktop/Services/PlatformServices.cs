using System.Windows.Interop;
using Microsoft.Win32;
using WriteMind.Desktop.Interop;

namespace WriteMind.Desktop.Services;

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
