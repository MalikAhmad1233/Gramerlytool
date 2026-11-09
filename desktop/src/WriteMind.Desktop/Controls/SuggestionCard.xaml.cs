using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using WriteMind.Core.Api;

namespace WriteMind.Desktop.Controls;

/// <summary>One suggestion with explicit choices. Nothing happens to the user's text until a button is clicked.</summary>
public partial class SuggestionCard : UserControl
{
    private Suggestion? _suggestion;

    public SuggestionCard() => InitializeComponent();

    public event EventHandler<(Suggestion Suggestion, string Replacement)>? AcceptRequested;
    public event EventHandler<Suggestion>? IgnoreRequested;
    public event EventHandler<Suggestion>? AddWordRequested;
    public event EventHandler<Suggestion>? DisableRuleRequested;
    public event EventHandler? CloseRequested;

    public bool ShowClose
    {
        get => CloseButton.Visibility == Visibility.Visible;
        set => CloseButton.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
    }

    public void Show(Suggestion suggestion, bool canEdit)
    {
        _suggestion = suggestion;
        CategoryText.Text = suggestion.Category.ToUpperInvariant();
        SeverityDot.Fill = (Brush)FindResource(suggestion.Severity switch
        {
            "error" => "ErrorBrush",
            "warning" => "WarningBrush",
            _ => "SuggestionBrush",
        });
        AiTag.Visibility = suggestion.Source == "ai" ? Visibility.Visible : Visibility.Collapsed;
        TitleText.Text = suggestion.Title;
        MessageText.Text = suggestion.Message;
        DictionaryButton.Visibility = suggestion.Category == Categories.Spelling ? Visibility.Visible : Visibility.Collapsed;
        CannotEditText.Visibility = canEdit ? Visibility.Collapsed : Visibility.Visible;

        Replacements.Children.Clear();
        var first = true;
        foreach (var replacement in suggestion.Replacements.Take(4))
        {
            var button = new Button
            {
                Content = replacement.Length == 0 ? "Remove" : replacement,
                Style = (Style)FindResource(first ? "PrimaryButton" : "SecondaryButton"),
                ToolTip = canEdit ? $"Replace “{suggestion.Original}” with “{replacement}”" : "Copy this correction",
            };
            var value = replacement;
            button.Click += (_, _) =>
            {
                if (canEdit) AcceptRequested?.Invoke(this, (suggestion, value));
                else Clipboard.SetText(value);
            };
            Replacements.Children.Add(button);
            first = false;
        }
    }

    private void OnClose(object sender, RoutedEventArgs e) => CloseRequested?.Invoke(this, EventArgs.Empty);

    private void OnIgnore(object sender, RoutedEventArgs e)
    {
        if (_suggestion is not null) IgnoreRequested?.Invoke(this, _suggestion);
    }

    private void OnAddWord(object sender, RoutedEventArgs e)
    {
        if (_suggestion is not null) AddWordRequested?.Invoke(this, _suggestion);
    }

    private void OnDisableRule(object sender, RoutedEventArgs e)
    {
        if (_suggestion is not null) DisableRuleRequested?.Invoke(this, _suggestion);
    }
}
