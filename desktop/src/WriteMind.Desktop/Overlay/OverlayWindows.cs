using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using WriteMind.Core.Api;
using WriteMind.Desktop.Controls;
using WriteMind.Desktop.Interop;

namespace WriteMind.Desktop.Overlay;

/// <summary>Screen rectangles (physical pixels) for one suggestion.</summary>
internal sealed record UnderlineItem(Suggestion Suggestion, Rect[] Rects);

/// <summary>
/// Transparent, click-through, never-focused window laid over the text control. It only draws; the user's
/// document is never modified to show highlights.
/// </summary>
internal sealed class UnderlineOverlay : Window
{
    private readonly Canvas _canvas = new() { IsHitTestVisible = false };
    private static readonly Brush ErrorBrush = Frozen(Color.FromRgb(0xE1, 0x1D, 0x48));
    private static readonly Brush WarningBrush = Frozen(Color.FromRgb(0xD9, 0x77, 0x06));
    private static readonly Brush SuggestionBrush = Frozen(Color.FromRgb(0x25, 0x63, 0xEB));
    private static readonly Brush AiBrush = Frozen(Color.FromRgb(0x7C, 0x3A, 0xED));
    private static readonly Brush HoverFill = Frozen(Color.FromArgb(0x26, 0x4F, 0x46, 0xE5));

    public UnderlineOverlay()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Topmost = true;
        Focusable = false;
        Content = _canvas;
        this.MakeNonActivating(clickThrough: true);
    }

    private static SolidColorBrush Frozen(Color c)
    {
        var b = new SolidColorBrush(c);
        b.Freeze();
        return b;
    }

    public void Render(Rect boundsPx, IReadOnlyList<UnderlineItem> items, string? hoveredId)
    {
        if (boundsPx.IsEmpty || boundsPx.Width < 4 || items.Count == 0)
        {
            Hide();
            return;
        }
        var area = Rect.Inflate(boundsPx, 2, 4);
        if (!IsVisible) Show();
        this.PlaceInPixels(area);
        var dpi = VisualTreeHelper.GetDpi(this);
        _canvas.Children.Clear();
        foreach (var item in items)
        {
            var brush = item.Suggestion.Source == "ai" ? AiBrush : item.Suggestion.Severity switch
            {
                "error" => ErrorBrush,
                "warning" => WarningBrush,
                _ => SuggestionBrush,
            };
            foreach (var r in item.Rects)
            {
                var clipped = Rect.Intersect(r, boundsPx);
                if (clipped.IsEmpty || clipped.Width < 1) continue;
                var x = (clipped.X - area.X) / dpi.DpiScaleX;
                var y = (clipped.Y - area.Y) / dpi.DpiScaleY;
                var w = clipped.Width / dpi.DpiScaleX;
                var h = clipped.Height / dpi.DpiScaleY;
                if (item.Suggestion.Id == hoveredId)
                {
                    var highlight = new Rectangle { Width = w, Height = h, Fill = HoverFill, RadiusX = 2, RadiusY = 2 };
                    Canvas.SetLeft(highlight, x);
                    Canvas.SetTop(highlight, y);
                    _canvas.Children.Add(highlight);
                }
                _canvas.Children.Add(Squiggle(x, y + h - 1, Math.Max(w, 4), brush, item.Suggestion.Id == hoveredId ? 2.0 : 1.5));
            }
        }
    }

    private static Path Squiggle(double x, double y, double width, Brush brush, double thickness)
    {
        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            const double wave = 4, amplitude = 1.5;
            ctx.BeginFigure(new Point(x, y), false, false);
            var up = true;
            for (var dx = wave / 2; dx <= width; dx += wave / 2)
            {
                ctx.LineTo(new Point(x + dx, y + (up ? -amplitude : amplitude)), true, true);
                up = !up;
            }
        }
        geometry.Freeze();
        return new Path { Data = geometry, Stroke = brush, StrokeThickness = thickness, IsHitTestVisible = false };
    }
}

/// <summary>"No issues" (✓) is only shown after a check of the current text actually succeeded.</summary>
internal enum BadgeState
{
    Ready,
    Checking,
    Error,
}

/// <summary>Small floating button near the text field showing how many suggestions there are.</summary>
internal sealed class BadgeWindow : Window
{
    private readonly TextBlock _count = new() { Foreground = Brushes.White, FontWeight = FontWeights.Bold, FontSize = 11, VerticalAlignment = VerticalAlignment.Center };
    private readonly Border _dot;

    public BadgeWindow()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Topmost = true;
        SizeToContent = SizeToContent.WidthAndHeight;
        _dot = new Border
        {
            CornerRadius = new CornerRadius(13),
            MinWidth = 26,
            Height = 26,
            Padding = new Thickness(8, 0, 8, 0),
            Background = (Brush)Application.Current.FindResource("BrandGradient"),
            Child = _count,
            Cursor = Cursors.Hand,
            Effect = (System.Windows.Media.Effects.Effect)Application.Current.FindResource("CardShadow"),
            Margin = new Thickness(6),
        };
        _count.HorizontalAlignment = HorizontalAlignment.Center;
        Content = _dot;
        _dot.MouseLeftButtonUp += (_, _) => Clicked?.Invoke(this, EventArgs.Empty);
        this.MakeNonActivating();
    }

    public event EventHandler? Clicked;

    public void ShowAt(Rect fieldPx, int count, BadgeState state)
    {
        _count.Text = state switch
        {
            BadgeState.Error => "!",
            BadgeState.Checking when count == 0 => "…",
            _ => count == 0 ? "✓" : count.ToString(CultureInfo.InvariantCulture),
        };
        _dot.Background = state == BadgeState.Error
            ? (Brush)Application.Current.FindResource("MutedBrush")
            : count == 0 && state == BadgeState.Ready ? (Brush)Application.Current.FindResource("OkBrush") : (Brush)Application.Current.FindResource("BrandGradient");
        ToolTip = state switch
        {
            BadgeState.Error => "WriteMind couldn't check this text",
            BadgeState.Checking when count == 0 => "Checking…",
            _ => count == 0 ? "No issues found" : $"{count} suggestion(s) — open WriteMind",
        };
        if (!IsVisible) Show();
        var dpi = VisualTreeHelper.GetDpi(this);
        var size = new Size(Math.Max(ActualWidth, 38) * dpi.DpiScaleX, Math.Max(ActualHeight, 38) * dpi.DpiScaleY);
        this.PlaceInPixels(new Rect(fieldPx.Right - size.Width - 4, fieldPx.Bottom - size.Height - 2, size.Width, size.Height));
    }
}

/// <summary>Suggestion card shown near an underline. Never takes focus, so the caret stays in the user's app.</summary>
internal sealed class SuggestionPopup : Window
{
    public SuggestionPopup()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Topmost = true;
        SizeToContent = SizeToContent.WidthAndHeight;
        Card = new SuggestionCard
        {
            Margin = new Thickness(12),
            Effect = (System.Windows.Media.Effects.Effect)Application.Current.FindResource("CardShadow"),
        };
        Content = Card;
        this.MakeNonActivating();
        KeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) Hide();
        };
    }

    public SuggestionCard Card { get; }

    public string? SuggestionId { get; private set; }

    public void ShowFor(Suggestion suggestion, bool canEdit, Rect anchorPx)
    {
        SuggestionId = suggestion.Id;
        Card.Show(suggestion, canEdit);
        if (!IsVisible) Show();
        UpdateLayout();
        var dpi = VisualTreeHelper.GetDpi(this);
        var w = ActualWidth * dpi.DpiScaleX;
        var h = ActualHeight * dpi.DpiScaleY;
        var screen = SystemParameters.WorkArea;
        var screenBottomPx = screen.Bottom * dpi.DpiScaleY;
        var top = anchorPx.Bottom + h > screenBottomPx ? anchorPx.Top - h : anchorPx.Bottom;
        this.PlaceInPixels(new Rect(anchorPx.Left - 12 * dpi.DpiScaleX, top, w, h));
    }

    public bool ContainsScreenPoint(Point px)
    {
        if (!IsVisible) return false;
        var dpi = VisualTreeHelper.GetDpi(this);
        var topLeft = PointToScreen(new Point(0, 0));
        return new Rect(topLeft, new Size(ActualWidth * dpi.DpiScaleX, ActualHeight * dpi.DpiScaleY)).Contains(px);
    }

    public new void Hide()
    {
        SuggestionId = null;
        base.Hide();
    }
}

/// <summary>Floating assistant docked to the right of the screen; non-activating so the user's app keeps focus.</summary>
internal sealed class AssistantWindow : Window
{
    public AssistantWindow()
    {
        Title = "WriteMind AI";
        Width = 380;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Topmost = true;
        Panel = new AssistantPanel { ShowCloseButton = true };
        Content = new Border
        {
            Margin = new Thickness(12),
            CornerRadius = new CornerRadius(14),
            BorderBrush = (Brush)Application.Current.FindResource("LineBrush"),
            BorderThickness = new Thickness(1),
            Background = (Brush)Application.Current.FindResource("BgBrush"),
            Effect = (System.Windows.Media.Effects.Effect)Application.Current.FindResource("CardShadow"),
            Child = Panel,
            ClipToBounds = true,
        };
        Panel.CloseRequested += (_, _) => Hide();
        this.MakeNonActivating();
    }

    public AssistantPanel Panel { get; }

    public void ShowDocked()
    {
        var area = SystemParameters.WorkArea;
        Height = Math.Min(720, area.Height - 24);
        Left = area.Right - Width - 8;
        Top = area.Top + 12;
        if (!IsVisible) Show();
    }
}
