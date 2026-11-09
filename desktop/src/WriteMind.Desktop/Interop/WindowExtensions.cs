using System.Windows;
using System.Windows.Interop;

namespace WriteMind.Desktop.Interop;

internal static class WindowExtensions
{
    /// <summary>
    /// Makes a window that never takes focus from the app the user is typing in: clicks on its buttons
    /// still work, but the caret and selection stay in Word/Outlook/Notepad.
    /// </summary>
    public static void MakeNonActivating(this Window window, bool clickThrough = false)
    {
        window.ShowActivated = false;
        window.SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(window).Handle;
            var flags = NativeMethods.WS_EX_NOACTIVATE | NativeMethods.WS_EX_TOOLWINDOW;
            if (clickThrough) flags |= NativeMethods.WS_EX_TRANSPARENT | NativeMethods.WS_EX_LAYERED;
            NativeMethods.AddExtendedStyle(hwnd, flags);
            HwndSource.FromHwnd(hwnd)?.AddHook((IntPtr _, int msg, IntPtr _, IntPtr _, ref bool handled) =>
            {
                if (msg != NativeMethods.WM_MOUSEACTIVATE) return IntPtr.Zero;
                handled = true;
                return new IntPtr(NativeMethods.MA_NOACTIVATE);
            });
        };
    }

    public static IntPtr Handle(this Window window) => new WindowInteropHelper(window).EnsureHandle();

    /// <summary>Positions a window in physical screen pixels (UI Automation coordinates).</summary>
    public static void PlaceInPixels(this Window window, Rect pixels)
    {
        NativeMethods.SetWindowPos(window.Handle(), NativeMethods.HWND_TOPMOST,
            (int)Math.Round(pixels.X), (int)Math.Round(pixels.Y),
            Math.Max(1, (int)Math.Round(pixels.Width)), Math.Max(1, (int)Math.Round(pixels.Height)),
            NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW);
    }
}
