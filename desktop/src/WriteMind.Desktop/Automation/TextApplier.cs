using System.Diagnostics;
using WriteMind.Core.Text;
using WriteMind.Desktop.Interop;

namespace WriteMind.Desktop.Automation;

internal enum ApplyOutcome
{
    Applied,
    Stale,         // the text changed since the suggestion was made: nothing was written
    Blocked,       // the span cannot be addressed in this control
    Elevated,      // the target app runs as administrator; Windows blocks input from WriteMind
    Failed,        // the host did not accept the edit
}

/// <summary>
/// The only code path that writes into another application, and it runs only after the user clicks
/// Accept/Replace. It re-reads and verifies the span, selects it through UI Automation, confirms the
/// selection, then types the replacement — so the host's undo history and formatting are preserved.
/// </summary>
internal static class TextApplier
{
    public static async Task<ApplyOutcome> ApplyAsync(TextControlAccessor accessor, int offset, int length, string original,
        string replacement, bool wholeWords, int maxChars)
    {
        var snapshot = accessor.Read(maxChars);
        if (!TextDiff.SpanStillValid(snapshot.Text, offset, offset + length, original, wholeWords)) return ApplyOutcome.Stale;

        if (!FocusTarget(accessor)) return ApplyOutcome.Failed;

        if (accessor.HasGeometry)
        {
            var range = accessor.RangeFor(snapshot, offset, length, original);
            if (range is null) return ApplyOutcome.Blocked;
            range.Select();
        }
        else if (accessor.IsClassicEdit && accessor.NativeHandle != IntPtr.Zero)
        {
            NativeMethods.SendMessage(accessor.NativeHandle, NativeMethods.EM_SETSEL, offset, offset + length);
        }
        else
        {
            return ApplyOutcome.Blocked;
        }

        await Task.Delay(40);
        // Never type unless exactly the expected text is selected.
        var selected = accessor.HasGeometry ? accessor.SelectedText() : original;
        if (!string.Equals(selected?.Replace("\r\n", "\r", StringComparison.Ordinal), original.Replace("\r\n", "\r", StringComparison.Ordinal), StringComparison.Ordinal))
            return ApplyOutcome.Stale;

        if (!NativeMethods.SendUnicodeText(replacement))
            return IsElevated(accessor.ProcessId) ? ApplyOutcome.Elevated : ApplyOutcome.Failed;

        // Verify: the host now shows the replacement between the same neighbouring text.
        var before = snapshot.Text[Math.Max(0, offset - 12)..offset];
        var after = snapshot.Text[(offset + length)..Math.Min(snapshot.Text.Length, offset + length + 12)];
        var needle = Normalise(before + replacement + after);
        for (var attempt = 0; attempt < 8; attempt++)
        {
            await Task.Delay(40);
            if (Normalise(accessor.Read(maxChars).Text).Contains(needle, StringComparison.Ordinal)) return ApplyOutcome.Applied;
        }
        return ApplyOutcome.Failed;
    }

    private static string Normalise(string s) => s.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').TrimEnd();

    private static bool FocusTarget(TextControlAccessor accessor)
    {
        try
        {
            var foreground = NativeMethods.GetForegroundWindow();
            NativeMethods.GetWindowThreadProcessId(foreground, out var pid);
            if (pid == accessor.ProcessId) return true;
            accessor.Element.SetFocus();
            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Windows.Automation.ElementNotAvailableException)
        {
            return false;
        }
    }

    private static bool IsElevated(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            _ = process.Handle; // access denied for elevated processes from an unelevated caller
            return false;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
