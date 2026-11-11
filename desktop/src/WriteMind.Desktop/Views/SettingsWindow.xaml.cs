using System.Windows;
using System.Windows.Controls;
using WriteMind.Core.Api;
using WriteMind.Core.Offline;
using WriteMind.Core.Privacy;
using WriteMind.Core.Settings;
using WriteMind.Desktop.Services;

namespace WriteMind.Desktop.Views;

public partial class SettingsWindow : Window
{
    private static readonly (string Code, string Name)[] Languages =
    [
        ("en-US", "English (US)"), ("en-GB", "English (UK)"), ("en-CA", "English (Canada)"), ("en-AU", "English (Australia)"),
        ("en-NZ", "English (New Zealand)"), ("en-ZA", "English (South Africa)"), ("de-DE", "German (beta)"), ("fr", "French (beta)"),
        ("es", "Spanish (beta)"), ("it", "Italian (beta)"), ("nl", "Dutch (beta)"), ("pt-PT", "Portuguese (beta)"), ("pt-BR", "Portuguese, Brazil (beta)"),
    ];

    private readonly SettingsStore _settings;
    private readonly HybridChecker _checker;
    private readonly Action<Uri> _changeApiUrl;
    private bool _loading;

    internal SettingsWindow(SettingsStore settings, HybridChecker checker, Action<Uri> changeApiUrl)
    {
        InitializeComponent();
        _settings = settings;
        _checker = checker;
        _changeApiUrl = changeApiUrl;
        foreach (var (code, name) in Languages) LanguageBox.Items.Add(new ComboBoxItem { Content = name, Tag = code });
        Load();
        _ = TestConnectionAsync();
    }

    private void Load()
    {
        _loading = true;
        var s = _settings.Current;
        ApiUrlBox.Text = s.ApiBaseUrl;
        LanguageBox.SelectedItem = LanguageBox.Items.Cast<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == s.Language);

        StyleChips.Children.Clear();
        foreach (var style in Styles.Check)
        {
            var chip = new RadioButton
            {
                Content = char.ToUpperInvariant(style[0]) + style[1..],
                Style = (Style)FindResource("Chip"),
                GroupName = "style",
                IsChecked = s.Style == style,
            };
            chip.Checked += (_, _) => _settings.Update(c => c with { Style = style });
            StyleChips.Children.Add(chip);
        }

        CategoryChecks.Children.Clear();
        foreach (var category in Categories.All)
        {
            var box = new CheckBox { Content = char.ToUpperInvariant(category[0]) + category[1..], IsChecked = s.Categories.Contains(category), Margin = new Thickness(0, 0, 16, 6) };
            box.Checked += (_, _) => _settings.Update(c => c with { Categories = c.Categories.Append(category).Distinct().ToList() });
            box.Unchecked += (_, _) => _settings.Update(c => c with { Categories = c.Categories.Where(x => x != category).ToList() });
            CategoryChecks.Children.Add(box);
        }

        AiCheck.IsChecked = s.AiEnabled;
        UnderlineCheck.IsChecked = s.ShowUnderlines;
        StartupCheck.IsChecked = s.StartWithWindows;
        GenericAppsCheck.IsChecked = s.CheckGenericApps;

        AppList.Children.Clear();
        var disabled = s.DisabledAppSet();
        foreach (var app in new AppCatalog().SupportedApps().OrderBy(a => a.DisplayName))
        {
            var process = app.ProcessName;
            var box = new CheckBox { Content = app.DisplayName, IsChecked = !disabled.Contains(process), Margin = new Thickness(0, 0, 0, 6) };
            box.Checked += (_, _) => _settings.Update(c => c with { DisabledApps = c.DisabledApps.Where(x => AppCatalog.NormaliseProcessName(x) != process).ToList() });
            box.Unchecked += (_, _) => _settings.Update(c => c with { DisabledApps = c.DisabledApps.Append(process).Distinct().ToList() });
            AppList.Children.Add(box);
        }

        RenderTags(WordList, s.Dictionary, RemoveWord);
        RenderTags(RuleList, s.DisabledRules, rule => _settings.Update(c => c with { DisabledRules = c.DisabledRules.Where(r => r != rule).ToList() }));
        _loading = false;
    }

    private void RenderTags(Panel panel, IReadOnlyList<string> items, Action<string> remove)
    {
        panel.Children.Clear();
        if (items.Count == 0)
        {
            panel.Children.Add(new TextBlock { Text = "Nothing here yet.", Style = (Style)FindResource("MutedText") });
            return;
        }
        foreach (var item in items)
        {
            var button = new Button { Content = $"{item}  ×", Style = (Style)FindResource("SecondaryButton"), ToolTip = $"Remove {item}" };
            var value = item;
            button.Click += (_, _) =>
            {
                remove(value);
                Load();
            };
            panel.Children.Add(button);
        }
    }

    private async void OnSaveUrl(object sender, RoutedEventArgs e)
    {
        if (!Uri.TryCreate(ApiUrlBox.Text.Trim(), UriKind.Absolute, out var uri) || (uri.Scheme != "https" && !uri.IsLoopback))
        {
            ConnectionText.Text = "Enter a valid https:// address (http is allowed only for localhost).";
            return;
        }
        _settings.Update(c => c with { ApiBaseUrl = uri.GetLeftPart(UriPartial.Authority) });
        _changeApiUrl(uri);
        await TestConnectionAsync();
    }

    private async Task TestConnectionAsync()
    {
        ConnectionText.Text = "Checking…";
        var server = await _checker.RefreshAsync();
        ConnectionText.Text = server
            ? $"Using the WriteMind server{(_checker.ServerHasAi ? " with AI suggestions" : "")}."
            : "Using the built-in checker — your text never leaves this PC.";
    }

    private void OnLanguageChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || LanguageBox.SelectedItem is not ComboBoxItem item) return;
        _settings.Update(c => c with { Language = (string)item.Tag });
    }

    private void OnTogglesChanged(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        _settings.Update(c => c with
        {
            AiEnabled = AiCheck.IsChecked == true,
            ShowUnderlines = UnderlineCheck.IsChecked == true,
            StartWithWindows = StartupCheck.IsChecked == true,
            CheckGenericApps = GenericAppsCheck.IsChecked == true,
        });
        StartupRegistration.Apply(_settings.Current.StartWithWindows);
    }

    private void OnAddWord(object sender, RoutedEventArgs e)
    {
        var word = WordBox.Text.Trim();
        if (word.Length == 0 || word.Any(char.IsWhiteSpace)) return;
        _settings.Update(c => c with { Dictionary = c.Dictionary.Append(word).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToList() });
        WordBox.Clear();
        Load();
    }

    private void RemoveWord(string word)
    {
        _settings.Update(c => c with { Dictionary = c.Dictionary.Where(w => !w.Equals(word, StringComparison.OrdinalIgnoreCase)).ToList() });
    }
}
