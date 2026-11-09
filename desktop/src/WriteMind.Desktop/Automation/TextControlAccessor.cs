using System.Diagnostics;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using WriteMind.Core.Privacy;
using WriteMind.Core.Text;

namespace WriteMind.Desktop.Automation;

/// <summary>Text read from a control at one moment. <see cref="Base"/> anchors offsets for TextPattern controls.</summary>
internal sealed record TextSnapshot(string Text, TextPatternRange? Base, bool Partial);

/// <summary>
/// Read access to a focused text control through UI Automation:
/// TextPattern (Word, Outlook, Notepad on Windows 11, WordPad, WhatsApp/WebView2) or ValuePattern (classic edits).
/// Large documents are read through their visible range only.
/// </summary>
internal sealed class TextControlAccessor
{
    private readonly TextPattern? _text;
    private readonly ValuePattern? _value;

    private TextControlAccessor(AutomationElement element, TextPattern? text, ValuePattern? value, int processId, string processName)
    {
        Element = element;
        _text = text;
        _value = value;
        ProcessId = processId;
        ProcessName = processName;
    }

    public AutomationElement Element { get; }
    public int ProcessId { get; }
    public string ProcessName { get; }
    public bool HasGeometry => _text is not null;
    public bool IsClassicEdit => Element.Current.ClassName.Equals("Edit", StringComparison.OrdinalIgnoreCase);
    public IntPtr NativeHandle => new(Element.Current.NativeWindowHandle);

    public static TextControlAccessor? TryCreate(AutomationElement element)
    {
        try
        {
            var pid = element.Current.ProcessId;
            string processName;
            try
            {
                using var process = Process.GetProcessById(pid);
                processName = process.ProcessName;
            }
            catch (ArgumentException)
            {
                return null;
            }
            var text = element.TryGetCurrentPattern(TextPattern.Pattern, out var t) ? (TextPattern)t : null;
            var value = element.TryGetCurrentPattern(ValuePattern.Pattern, out var v) ? (ValuePattern)v : null;
            return new TextControlAccessor(element, text, value, pid, processName);
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }
    }

    /// <summary>Everything the privacy policy needs — gathered without reading any text.</summary>
    public FieldDescriptor Describe(int ownProcessId)
    {
        var c = Element.Current;
        return new FieldDescriptor
        {
            ProcessName = ProcessName,
            ControlType = c.ControlType.ProgrammaticName.Replace("ControlType.", "", StringComparison.Ordinal),
            ClassName = c.ClassName ?? "",
            Name = c.Name ?? "",
            AutomationId = c.AutomationId ?? "",
            IsPassword = c.IsPassword,
            IsEnabled = c.IsEnabled,
            IsReadOnly = _value?.Current.IsReadOnly == true && _text is null,
            HasTextPattern = _text is not null,
            HasValuePattern = _value is not null,
            IsOwnProcess = ProcessId == ownProcessId,
        };
    }

    public Rect Bounds
    {
        get
        {
            try
            {
                return Element.Current.BoundingRectangle;
            }
            catch (ElementNotAvailableException)
            {
                return Rect.Empty;
            }
        }
    }

    public TextSnapshot Read(int maxChars)
    {
        if (_text is not null)
        {
            var document = _text.DocumentRange;
            var all = document.GetText(maxChars + 1);
            if (all.Length <= maxChars) return new TextSnapshot(all, document, Partial: false);

            // Long document: check what is on screen, extended to whole paragraphs.
            var visible = _text.GetVisibleRanges();
            if (visible.Length == 0) return new TextSnapshot(all[..maxChars], document, Partial: true);
            var range = visible[0].Clone();
            range.MoveEndpointByRange(TextPatternRangeEndpoint.End, visible[^1], TextPatternRangeEndpoint.End);
            range.ExpandToEnclosingUnit(TextUnit.Paragraph);
            var last = visible[^1].Clone();
            last.ExpandToEnclosingUnit(TextUnit.Paragraph);
            range.MoveEndpointByRange(TextPatternRangeEndpoint.End, last, TextPatternRangeEndpoint.End);
            return new TextSnapshot(range.GetText(maxChars), range, Partial: true);
        }
        var value = _value?.Current.Value ?? string.Empty;
        return new TextSnapshot(value.Length > maxChars ? value[..maxChars] : value, null, Partial: value.Length > maxChars);
    }

    /// <summary>
    /// The UI Automation range for [offset, offset+length) of <paramref name="snapshot"/>. Character counting can
    /// drift in some hosts (CR/LF handling), so the result is verified and, if needed, re-found by occurrence.
    /// </summary>
    public TextPatternRange? RangeFor(TextSnapshot snapshot, int offset, int length, string original)
    {
        if (snapshot.Base is null) return null;
        try
        {
            var range = snapshot.Base.Clone();
            range.MoveEndpointByRange(TextPatternRangeEndpoint.End, range, TextPatternRangeEndpoint.Start);
            range.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, offset + length);
            range.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, offset);
            if (string.Equals(range.GetText(-1), original, StringComparison.Ordinal)) return range;

            var occurrence = TextSpanLocator.OccurrenceIndex(snapshot.Text, offset, original);
            var search = snapshot.Base.Clone();
            for (var i = 0; i <= occurrence; i++)
            {
                var found = search.FindText(original, backward: false, ignoreCase: false);
                if (found is null) return null;
                if (i == occurrence) return found;
                search.MoveEndpointByRange(TextPatternRangeEndpoint.Start, found, TextPatternRangeEndpoint.End);
            }
        }
        catch (ElementNotAvailableException)
        {
        }
        catch (InvalidOperationException)
        {
        }
        return null;
    }

    /// <summary>Screen rectangles (physical pixels) covering the span, one per visual line.</summary>
    public Rect[] RectsFor(TextSnapshot snapshot, int offset, int length, string original)
    {
        try
        {
            return RangeFor(snapshot, offset, length, original)?.GetBoundingRectangles() ?? [];
        }
        catch (ElementNotAvailableException)
        {
            return [];
        }
    }

    /// <summary>Current selection as offsets into <paramref name="snapshot"/>; null if unavailable.</summary>
    public (int Start, int End)? Selection(TextSnapshot snapshot)
    {
        if (_text is null || snapshot.Base is null) return null;
        try
        {
            var selection = _text.GetSelection();
            if (selection.Length == 0) return null;
            var sel = selection[0];
            var before = snapshot.Base.Clone();
            before.MoveEndpointByRange(TextPatternRangeEndpoint.End, sel, TextPatternRangeEndpoint.Start);
            var start = before.GetText(-1).Length;
            var length = sel.GetText(-1).Length;
            if (start > snapshot.Text.Length) return null;
            return (start, Math.Min(snapshot.Text.Length, start + length));
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or ArgumentException)
        {
            return null;
        }
    }

    public string? SelectedText()
    {
        try
        {
            var selection = _text?.GetSelection();
            return selection is { Length: > 0 } ? selection[0].GetText(-1) : null;
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return null;
        }
    }
}
