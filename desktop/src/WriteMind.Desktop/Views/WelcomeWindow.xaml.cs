using System.Windows;
using System.Windows.Media;
using WriteMind.Core.Settings;
using WriteMind.Desktop.Services;

namespace WriteMind.Desktop.Views;

/// <summary>First-run window: choose American or British English, learn the three basics, start with Windows.</summary>
public partial class WelcomeWindow : Window
{
    private readonly SettingsStore _settings;
    private readonly Action _openEditor;

    internal WelcomeWindow(SettingsStore settings, Action openEditor)
    {
        InitializeComponent();
        _settings = settings;
        _openEditor = openEditor;
        StartupCheck.IsChecked = settings.Current.StartWithWindows;
        ShowLanguage();
        Closed += (_, _) => Finish();
    }

    private static bool IsBritish(string language) =>
        language.Equals("en-GB", StringComparison.OrdinalIgnoreCase) || language.Equals("en-AU", StringComparison.OrdinalIgnoreCase) ||
        language.Equals("en-NZ", StringComparison.OrdinalIgnoreCase) || language.Equals("en-ZA", StringComparison.OrdinalIgnoreCase);

    private void ShowLanguage()
    {
        var british = IsBritish(_settings.Current.Language);
        AmericanButton.IsChecked = !british;
        BritishButton.IsChecked = british;
        var brand = (Brush)FindResource("BrandBrush");
        var line = (Brush)FindResource("LineBrush");
        AmericanButton.BorderBrush = british ? line : brand;
        BritishButton.BorderBrush = british ? brand : line;
        AmericanButton.BorderThickness = BritishButton.BorderThickness = new Thickness(2);
    }

    private void OnAmerican(object sender, RoutedEventArgs e)
    {
        _settings.Update(s => s with { Language = "en-US" });
        ShowLanguage();
    }

    private void OnBritish(object sender, RoutedEventArgs e)
    {
        _settings.Update(s => s with { Language = "en-GB" });
        ShowLanguage();
    }

    private void OnTryEditor(object sender, RoutedEventArgs e)
    {
        Close();
        _openEditor();
    }

    private void OnDone(object sender, RoutedEventArgs e) => Close();

    private void Finish()
    {
        var startup = StartupCheck.IsChecked == true;
        _settings.Update(s => s with { StartWithWindows = startup, Onboarded = true });
        StartupRegistration.Apply(startup);
    }
}
