using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using WriteMind.Core.Api;

namespace WriteMind.Desktop.Controls;

/// <summary>All suggestions for the current text plus the Rewrite tool. Used by the floating assistant and the editor.</summary>
public partial class AssistantPanel : UserControl
{
    private static readonly Dictionary<string, string> StyleLabels = new()
    {
        ["neutral"] = "Neutral",
        ["professional"] = "Professional",
        ["casual"] = "Casual",
        ["formal"] = "Formal",
        ["friendly"] = "Friendly",
        ["concise"] = "Concise",
    };

    private string _rewriteStyle = "professional";
    private bool _suppressStyleEvent;

    public AssistantPanel()
    {
        InitializeComponent();
        foreach (var style in Styles.Check)
        {
            var chip = new RadioButton { Content = StyleLabels[style], Style = (Style)FindResource("Chip"), GroupName = "check-style", Tag = style };
            chip.Checked += (_, _) =>
            {
                if (!_suppressStyleEvent) StyleChanged?.Invoke(this, style);
            };
            StylePicker.Children.Add(chip);
        }
        foreach (var style in Styles.Rewrite)
        {
            var chip = new RadioButton
            {
                Content = StyleLabels[style],
                Style = (Style)FindResource("Chip"),
                GroupName = "rewrite-style",
                Tag = style,
                IsChecked = style == _rewriteStyle,
            };
            chip.Checked += (_, _) =>
            {
                _rewriteStyle = style;
                Alternatives.Children.Clear();
            };
            RewriteStyles.Children.Add(chip);
        }
    }

    public event EventHandler<(Suggestion Suggestion, string Replacement)>? AcceptRequested;
    public event EventHandler<Suggestion>? IgnoreRequested;
    public event EventHandler<Suggestion>? AddWordRequested;
    public event EventHandler<Suggestion>? DisableRuleRequested;
    public event EventHandler<string>? StyleChanged;
    public event EventHandler<string>? GenerateRequested;
    public event EventHandler? UseSelectionRequested;
    public event EventHandler<RewriteAlternative>? ReplaceRequested;
    public event EventHandler? CloseRequested;

    public bool ShowCloseButton
    {
        get => CloseButton.Visibility == Visibility.Visible;
        set => CloseButton.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
    }

    public void SetStyle(string style)
    {
        _suppressStyleEvent = true;
        foreach (var chip in StylePicker.Children.OfType<RadioButton>()) chip.IsChecked = (string)chip.Tag == style;
        _suppressStyleEvent = false;
    }

    public void ShowTab(bool rewrite)
    {
        if (rewrite) RewriteTab.IsChecked = true;
        else IssuesTab.IsChecked = true;
    }

    public void SetSuggestions(IReadOnlyList<Suggestion> suggestions, int? score, int words, Func<Suggestion, bool> canEdit)
    {
        IssuesTabText.Text = $"Suggestions ({suggestions.Count})";
        ScorePanel.Visibility = score is null ? Visibility.Collapsed : Visibility.Visible;
        ScoreText.Text = score?.ToString(CultureInfo.InvariantCulture) ?? "";
        var counts = suggestions.GroupBy(s => s.Category).Select(g => $"{Capitalise(g.Key)} · {g.Count()}");
        Summary.Text = string.Join("    ", counts.Append($"{words} words"));
        EmptyState.Visibility = suggestions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        IssueList.Children.Clear();
        foreach (var s in suggestions.Take(100))
        {
            var card = new SuggestionCard { Margin = new Thickness(0, 0, 0, 8), ShowClose = false };
            card.Show(s, canEdit(s));
            card.AcceptRequested += (_, e) => AcceptRequested?.Invoke(this, e);
            card.IgnoreRequested += (_, e) => IgnoreRequested?.Invoke(this, e);
            card.AddWordRequested += (_, e) => AddWordRequested?.Invoke(this, e);
            card.DisableRuleRequested += (_, e) => DisableRuleRequested?.Invoke(this, e);
            IssueList.Children.Add(PreviewWrapper(s, card));
        }
    }

    private static UIElement PreviewWrapper(Suggestion s, SuggestionCard card)
    {
        if (s.Replacements.Count == 0) return card;
        var preview = new TextBlock { Margin = new Thickness(14, 0, 0, 4), FontSize = 13 };
        preview.Inlines.Add(new Run(s.Original.Length == 0 ? "∅" : s.Original)
        {
            TextDecorations = TextDecorations.Strikethrough,
            Foreground = (Brush)card.FindResource("ErrorBrush"),
        });
        preview.Inlines.Add(new Run("  →  "));
        preview.Inlines.Add(new Bold(new Run(s.Replacements[0].Length == 0 ? "(remove)" : s.Replacements[0])));
        var stack = new StackPanel();
        stack.Children.Add(preview);
        stack.Children.Add(card);
        return stack;
    }

    public void SetRewriteSource(string source)
    {
        RewriteSource.Text = string.IsNullOrWhiteSpace(source) ? "Select text in your document (or place the cursor in a sentence)." : source;
        GenerateButton.IsEnabled = !string.IsNullOrWhiteSpace(source);
        Alternatives.Children.Clear();
        RewriteMessage.Visibility = Visibility.Collapsed;
    }

    public void SetRewriteBusy(bool busy)
    {
        GenerateButton.IsEnabled = !busy;
        GenerateButton.Content = busy ? "Thinking…" : "Suggest alternatives";
    }

    public void SetAlternatives(IReadOnlyList<RewriteAlternative> alternatives, string? message)
    {
        Alternatives.Children.Clear();
        RewriteMessage.Text = message ?? "";
        RewriteMessage.Visibility = string.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
        foreach (var alt in alternatives)
        {
            var body = new StackPanel();
            body.Children.Add(new TextBlock { Text = alt.Text, Style = (Style)FindResource("BodyText"), FontSize = 14 });
            var note = (alt.Source == "ai" ? "AI suggestion" : "WriteMind rules") + " · meaning preserved" +
                       (alt.Notes.Count > 0 ? " · " + string.Join(" · ", alt.Notes) : "");
            body.Children.Add(new TextBlock { Text = note, Style = (Style)FindResource("MutedText"), FontSize = 11, Margin = new Thickness(0, 4, 0, 8) });
            var actions = new WrapPanel();
            var replace = new Button { Content = "Replace", Style = (Style)FindResource("PrimaryButton") };
            replace.Click += (_, _) => ReplaceRequested?.Invoke(this, alt);
            var copy = new Button { Content = "Copy", Style = (Style)FindResource("SecondaryButton") };
            copy.Click += (_, _) => Clipboard.SetText(alt.Text);
            actions.Children.Add(replace);
            actions.Children.Add(copy);
            body.Children.Add(actions);
            Alternatives.Children.Add(new Border { Style = (Style)FindResource("CardBorder"), Margin = new Thickness(0, 0, 0, 8), Child = body });
        }
    }

    private static string Capitalise(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];

    private void OnTabChanged(object sender, RoutedEventArgs e)
    {
        if (IssuesView is null || RewriteView is null) return; // during InitializeComponent
        var rewrite = RewriteTab.IsChecked == true;
        IssuesView.Visibility = rewrite ? Visibility.Collapsed : Visibility.Visible;
        RewriteView.Visibility = rewrite ? Visibility.Visible : Visibility.Collapsed;
        if (rewrite) UseSelectionRequested?.Invoke(this, EventArgs.Empty);
    }

    private void OnGenerate(object sender, RoutedEventArgs e) => GenerateRequested?.Invoke(this, _rewriteStyle);

    private void OnUseSelection(object sender, RoutedEventArgs e) => UseSelectionRequested?.Invoke(this, EventArgs.Empty);

    private void OnClose(object sender, RoutedEventArgs e) => CloseRequested?.Invoke(this, EventArgs.Empty);
}
