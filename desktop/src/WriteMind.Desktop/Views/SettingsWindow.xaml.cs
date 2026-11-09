using System.Windows;
using System.Windows.Controls;
using WriteMind.Core.Api;
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
    private readonly WriteMindApiClient _api;
    private readonly Action<Uri> _changeApiUrl;
    private bool _loading;

    internal SettingsWindow(SettingsStore settings, WriteMindApiClient api, Action<Uri> changeApiUrl)
    {
        InitializeComponent();
        _settings = settings;
        _api = api;
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
        RenderAccount();
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

    private void RenderAccount()
    {
        var user = _api.CurrentUser;
        SignedOutPanel.Visibility = user is null ? Visibility.Visible : Visibility.Collapsed;
        SignedInPanel.Visibility = user is null ? Visibility.Collapsed : Visibility.Visible;
        if (user is not null)
        {
            UserText.Text = user.DisplayName ?? user.Email;
            UserDetail.Text = $"{user.Email} · {user.Plan} plan";
        }
    }

    private async Task RunAsync(Func<Task> action, string? success = null)
    {
        AccountMessage.Text = "";
        IsEnabled = false;
        try
        {
            await action();
            if (success is not null) AccountMessage.Text = success;
        }
        catch (WriteMindApiException ex)
        {
            AccountMessage.Text = ex.Message;
        }
        finally
        {
            IsEnabled = true;
            Load();
        }
    }

    private async void OnSignIn(object sender, RoutedEventArgs e) =>
        await RunAsync(async () =>
        {
            await _api.LoginAsync(EmailBox.Text.Trim(), PasswordBox.Password);
            await SyncService.PullAsync(_settings, _api);
        }, "Signed in. Your dictionary and preferences are synced.");

    private async void OnRegister(object sender, RoutedEventArgs e) =>
        await RunAsync(async () =>
        {
            await _api.RegisterAsync(EmailBox.Text.Trim(), PasswordBox.Password, string.IsNullOrWhiteSpace(NameBox.Text) ? null : NameBox.Text.Trim());
            await SyncService.PushAsync(_settings, _api);
        }, "Account created.");

    private async void OnSync(object sender, RoutedEventArgs e) =>
        await RunAsync(async () =>
        {
            await SyncService.PushAsync(_settings, _api);
            await SyncService.PullAsync(_settings, _api);
        }, "Synced.");

    private async void OnSignOut(object sender, RoutedEventArgs e) => await RunAsync(() => _api.LogoutAsync());

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
        ConnectionText.Text = "Testing connection…";
        try
        {
            var meta = await _api.MetaAsync();
            ConnectionText.Text = $"Connected to {meta.Name} {meta.Version} · {(meta.AiAvailable ? "AI suggestions available" : "grammar engine only")}";
        }
        catch (WriteMindApiException ex)
        {
            ConnectionText.Text = ex.Message;
        }
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
        if (_api.CurrentUser is not null) _ = _api.AddWordAsync(word).ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        WordBox.Clear();
        Load();
    }

    private void RemoveWord(string word)
    {
        _settings.Update(c => c with { Dictionary = c.Dictionary.Where(w => !w.Equals(word, StringComparison.OrdinalIgnoreCase)).ToList() });
        if (_api.CurrentUser is not null) _ = _api.RemoveWordAsync(word).ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
    }
}
