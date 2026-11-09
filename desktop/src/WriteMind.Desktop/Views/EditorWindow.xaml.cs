using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Win32;
using WriteMind.Core.Api;
using WriteMind.Core.Scheduling;
using WriteMind.Core.Settings;
using WriteMind.Core.Text;

namespace WriteMind.Desktop.Views;

/// <summary>Built-in editor with inline suggestions. Corrections are applied only from Accept/Replace clicks.</summary>
public partial class EditorWindow : Window
{
    private const int MaxChars = 20_000;
    private readonly SettingsStore _settings;
    private readonly WriteMindApiClient _api;
    private readonly SuggestionTracker _tracker;
    private readonly CheckScheduler _scheduler;
    private readonly SquiggleAdorner _adorner;
    private CancellationTokenSource _fastCts = new();
    private CancellationTokenSource _fullCts = new();
    private (int Start, int End, string Source)? _rewrite;
    private string _engineStatus = "";

    public EditorWindow(SettingsStore settings, WriteMindApiClient api)
    {
        InitializeComponent();
        _settings = settings;
        _api = api;
        _tracker = new SuggestionTracker(() => _settings.Current.ToFilters());
        _tracker.Changed += (_, _) => Dispatcher.BeginInvoke(Refresh);
        _scheduler = new CheckScheduler(mode => Dispatcher.BeginInvoke(() => _ = RunCheckAsync(mode)), () => _settings.Current.AiEnabled);

        _adorner = new SquiggleAdorner(Editor, () => _tracker.Visible());
        Loaded += (_, _) => AdornerLayer.GetAdornerLayer(Editor)?.Add(_adorner);
        Editor.TextChanged += (_, _) =>
        {
            _tracker.SetText(Editor.Text);
            _scheduler.Poke();
        };
        Editor.AddHandler(ScrollViewer.ScrollChangedEvent, new ScrollChangedEventHandler((_, _) => _adorner.InvalidateVisual()));
        Editor.SizeChanged += (_, _) => _adorner.InvalidateVisual();
        Editor.PreviewMouseLeftButtonUp += OnEditorClick;

        Card.AcceptRequested += (_, e) => Accept(e.Suggestion, e.Replacement);
        Card.IgnoreRequested += (_, s) => Ignore(s);
        Card.AddWordRequested += (_, s) => AddWord(s);
        Card.DisableRuleRequested += (_, s) => DisableRule(s);
        Card.CloseRequested += (_, _) => CardPopup.IsOpen = false;

        Panel.AcceptRequested += (_, e) => Accept(e.Suggestion, e.Replacement);
        Panel.IgnoreRequested += (_, s) => Ignore(s);
        Panel.AddWordRequested += (_, s) => AddWord(s);
        Panel.DisableRuleRequested += (_, s) => DisableRule(s);
        Panel.StyleChanged += (_, style) =>
        {
            _settings.Update(c => c with { Style = style });
            _scheduler.Poke(immediate: true);
        };
        Panel.UseSelectionRequested += (_, _) => PrepareRewrite();
        Panel.GenerateRequested += (_, style) => _ = GenerateAsync(style);
        Panel.ReplaceRequested += (_, alt) => ApplyRewrite(alt);
        Panel.SetStyle(_settings.Current.Style);
        Refresh();
        Closed += (_, _) => _scheduler.Dispose();
    }

    private async Task RunCheckAsync(string mode)
    {
        var text = Editor.Text.Length > MaxChars ? Editor.Text[..MaxChars] : Editor.Text;
        if (string.IsNullOrWhiteSpace(text))
        {
            Refresh();
            return;
        }
        var settings = _settings.Current;
        CancellationTokenSource cts;
        if (mode == "fast")
        {
            await _fastCts.CancelAsync();
            _fastCts = cts = new CancellationTokenSource();
        }
        else
        {
            await _fullCts.CancelAsync();
            _fullCts = cts = new CancellationTokenSource();
        }
        try
        {
            var response = await _api.CheckAsync(new CheckRequest
            {
                Text = text,
                Mode = mode,
                Language = settings.Language,
                Style = settings.Style,
                Client = new ClientContext("windows-desktop", "writemind-editor"),
                Dictionary = settings.Dictionary,
                DisabledRules = settings.DisabledRules,
                Ai = settings.AiEnabled,
            }, cts.Token);
            _tracker.Apply(text, response);
            _engineStatus = response.Engine.Ai == "used" ? "Grammar engine + AI" : "Grammar engine";
        }
        catch (OperationCanceledException)
        {
        }
        catch (WriteMindApiException ex)
        {
            _engineStatus = ex.IsOffline ? "Offline — can't reach the WriteMind service" : ex.Message;
            Refresh();
        }
    }

    private void Refresh()
    {
        var visible = _tracker.Visible();
        Panel.SetSuggestions(visible, _tracker.Score, WordCounter.Count(Editor.Text), _ => true);
        var words = WordCounter.Count(Editor.Text);
        StatusText.Text = string.Create(CultureInfo.CurrentCulture,
            $"{words} words · {visible.Count} suggestion(s){(_tracker.Score is { } s ? $" · score {s}" : "")}{(_engineStatus.Length > 0 ? " · " + _engineStatus : "")}");
        _adorner.InvalidateVisual();
    }

    private void OnEditorClick(object sender, MouseButtonEventArgs e)
    {
        var index = Editor.GetCharacterIndexFromPoint(e.GetPosition(Editor), snapToText: false);
        if (index < 0) return;
        var hit = _tracker.Visible().FirstOrDefault(s => index >= s.Offset && index < s.End);
        if (hit is null) return;
        Card.Show(hit, canEdit: true);
        CardPopup.IsOpen = true;
    }

    private void Accept(Suggestion s, string replacement)
    {
        CardPopup.IsOpen = false;
        if (!TextDiff.SpanStillValid(Editor.Text, s.Offset, s.End, s.Original))
        {
            _tracker.Remove(s.Id);
            _scheduler.Poke(immediate: true);
            return;
        }
        Editor.Select(s.Offset, s.Length);
        Editor.SelectedText = replacement; // undoable with Ctrl+Z
        Editor.CaretIndex = s.Offset + replacement.Length;
        Editor.Focus();
        _ = _api.SendFeedbackAsync([new FeedbackEvent(s.RuleId, s.Category, s.Source, "accepted")]).ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
    }

    private void Ignore(Suggestion s)
    {
        CardPopup.IsOpen = false;
        _tracker.Ignore(s);
        _ = _api.SendFeedbackAsync([new FeedbackEvent(s.RuleId, s.Category, s.Source, "ignored")]).ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
    }

    private void AddWord(Suggestion s)
    {
        CardPopup.IsOpen = false;
        var word = s.Original.Trim();
        _settings.Update(c => c with { Dictionary = c.Dictionary.Append(word).Distinct(StringComparer.OrdinalIgnoreCase).ToList() });
        if (_api.CurrentUser is not null) _ = _api.AddWordAsync(word).ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        _tracker.Refresh();
    }

    private void DisableRule(Suggestion s)
    {
        CardPopup.IsOpen = false;
        _settings.Update(c => c with { DisabledRules = c.DisabledRules.Append(s.RuleId).Distinct().ToList() });
        _tracker.Refresh();
    }

    private void PrepareRewrite()
    {
        var text = Editor.Text;
        var (start, end) = Editor.SelectionLength > 0
            ? (Editor.SelectionStart, Editor.SelectionStart + Editor.SelectionLength)
            : SentenceFinder.Around(text, Editor.CaretIndex);
        var source = text[start..end];
        _rewrite = string.IsNullOrWhiteSpace(source) ? null : (start, end, source);
        Panel.SetRewriteSource(source);
    }

    private async Task GenerateAsync(string style)
    {
        if (_rewrite is not { } r) return;
        Panel.SetRewriteBusy(true);
        try
        {
            var response = await _api.RewriteAsync(new RewriteRequest
            {
                Text = r.Source,
                Style = style,
                Language = _settings.Current.Language,
                Client = new ClientContext("windows-desktop", "writemind-editor"),
                Ai = _settings.Current.AiEnabled,
            });
            Panel.SetAlternatives(response.Alternatives, response.Alternatives.Count == 0 ? "Your text already reads well in this style." : null);
        }
        catch (WriteMindApiException ex)
        {
            Panel.SetAlternatives([], ex.Message);
        }
        finally
        {
            Panel.SetRewriteBusy(false);
        }
    }

    private void ApplyRewrite(RewriteAlternative alternative)
    {
        if (_rewrite is not { } r) return;
        if (!TextDiff.SpanStillValid(Editor.Text, r.Start, r.End, r.Source, wholeWords: false))
        {
            Panel.SetAlternatives([], "The text changed since you selected it. Select it again to rewrite.");
            return;
        }
        Editor.Select(r.Start, r.End - r.Start);
        Editor.SelectedText = alternative.Text;
        _rewrite = null;
        Panel.SetRewriteSource("");
        Editor.Focus();
    }

    private void OnNew(object sender, RoutedEventArgs e) => Editor.Clear();

    private void OnOpen(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Filter = "Text files (*.txt;*.md)|*.txt;*.md|All files (*.*)|*.*" };
        if (dialog.ShowDialog(this) == true) Editor.Text = File.ReadAllText(dialog.FileName);
    }

    private void OnSave(object sender, RoutedEventArgs e)
    {
        var dialog = new SaveFileDialog { Filter = "Text file (*.txt)|*.txt|Markdown (*.md)|*.md", FileName = "document.txt" };
        if (dialog.ShowDialog(this) == true) File.WriteAllText(dialog.FileName, Editor.Text);
    }

    private void OnCopyAll(object sender, RoutedEventArgs e) => Clipboard.SetText(Editor.Text);
}

/// <summary>Draws squiggles under suggestion spans. Purely visual: the document text is never styled.</summary>
internal sealed class SquiggleAdorner : Adorner
{
    private readonly TextBox _box;
    private readonly Func<IReadOnlyList<Suggestion>> _suggestions;
    private static readonly Pen ErrorPen = Frozen(Color.FromRgb(0xE1, 0x1D, 0x48));
    private static readonly Pen WarningPen = Frozen(Color.FromRgb(0xD9, 0x77, 0x06));
    private static readonly Pen SuggestionPen = Frozen(Color.FromRgb(0x25, 0x63, 0xEB));
    private static readonly Pen AiPen = Frozen(Color.FromRgb(0x7C, 0x3A, 0xED));

    public SquiggleAdorner(TextBox box, Func<IReadOnlyList<Suggestion>> suggestions) : base(box)
    {
        _box = box;
        _suggestions = suggestions;
        IsHitTestVisible = false;
    }

    private static Pen Frozen(Color c)
    {
        var pen = new Pen(new SolidColorBrush(c), 1.4);
        pen.Freeze();
        return pen;
    }

    protected override void OnRender(DrawingContext dc)
    {
        var length = _box.Text.Length;
        var viewport = new Rect(0, 0, _box.ActualWidth, _box.ActualHeight);
        dc.PushClip(new RectangleGeometry(viewport));
        foreach (var s in _suggestions().Take(300))
        {
            if (s.Offset >= length) continue;
            var pen = s.Source == "ai" ? AiPen : s.Severity switch { "error" => ErrorPen, "warning" => WarningPen, _ => SuggestionPen };
            foreach (var line in LineSegments(s.Offset, Math.Min(s.End, length)))
            {
                if (line.Bottom < 0 || line.Top > viewport.Height) continue;
                DrawSquiggle(dc, pen, line.Left, line.Bottom - 1, Math.Max(line.Width, 4));
            }
        }
        dc.Pop();
    }

    private IEnumerable<Rect> LineSegments(int start, int end)
    {
        Rect? current = null;
        for (var i = start; i < Math.Max(end, start + 1); i++)
        {
            var leading = _box.GetRectFromCharacterIndex(i);
            var trailing = _box.GetRectFromCharacterIndex(i, trailingEdge: true);
            if (leading.IsEmpty || trailing.IsEmpty) continue;
            var glyph = new Rect(leading.TopLeft, new Point(Math.Max(trailing.Right, leading.Left + 1), leading.Bottom));
            if (current is { } c && Math.Abs(c.Top - glyph.Top) < 1)
            {
                current = Rect.Union(c, glyph);
            }
            else
            {
                if (current is { } done) yield return done;
                current = glyph;
            }
        }
        if (current is { } last) yield return last;
    }

    private static void DrawSquiggle(DrawingContext dc, Pen pen, double x, double y, double width)
    {
        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            ctx.BeginFigure(new Point(x, y), false, false);
            var up = true;
            for (var dx = 2.0; dx <= width; dx += 2.0)
            {
                ctx.LineTo(new Point(x + dx, y + (up ? -1.5 : 1.5)), true, true);
                up = !up;
            }
        }
        geometry.Freeze();
        dc.DrawGeometry(null, pen, geometry);
    }
}
