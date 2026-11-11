using System.IO;
using System.Windows;
using WriteMind.Core.Api;
using WriteMind.Core.Offline;
using WriteMind.Core.Settings;
using WriteMind.Desktop.Services;
using WriteMind.Desktop.Views;

namespace WriteMind.Desktop;

public partial class App : Application
{
    private const string InstanceName = "Local\\WriteMind.Desktop.SingleInstance";
    private const string ShowEventName = "Local\\WriteMind.Desktop.Show";

    private Mutex? _instance;
    private EventWaitHandle? _showSignal;
    private SettingsStore? _settings;
    private WriteMindApiClient? _api;
    private HybridChecker? _checker;
    private AssistantController? _assistant;
    private TrayIcon? _tray;
    private HotkeyService? _hotkeys;
    private EditorWindow? _editor;
    private SettingsWindow? _settingsWindow;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        _instance = new Mutex(initiallyOwned: true, InstanceName, out var isFirst);
        if (!isFirst)
        {
            // Already running: ask the existing instance to show its editor, then exit.
            if (EventWaitHandle.TryOpenExisting(ShowEventName, out var existing)) existing.Set();
            Shutdown();
            return;
        }
        _showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        new Thread(() =>
        {
            while (_showSignal.WaitOne()) Dispatcher.BeginInvoke(OpenEditor);
        }) { IsBackground = true, Name = "WriteMind show signal" }.Start();

        DispatcherUnhandledException += (_, args) =>
        {
            args.Handled = true;
            _tray?.Notify("Something went wrong, but WriteMind kept running.");
        };

        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WriteMind");
        _settings = new SettingsStore(dataDir, new DpapiProtector());
        _api = new WriteMindApiClient(new Uri(_settings.Current.ApiBaseUrl), _settings);
        // Works with no server: the built-in checker takes over whenever the WriteMind server is unreachable.
        _checker = new HybridChecker(_api);
        _ = Task.Run(() => Speller.For(_settings.Current.Language)); // warm up the dictionary

        _assistant = new AssistantController(_settings, _api, _checker, Dispatcher);
        _tray = new TrayIcon(OpenEditor, () => _assistant.OpenAssistant(rewrite: false), OpenSettings,
            d => _assistant.Pause(d), () => _assistant.Resume(), Quit);
        _assistant.Notify += (_, message) => Dispatcher.BeginInvoke(() => _tray.Notify(message));
        _assistant.ActiveAppChanged += (_, app) => Dispatcher.BeginInvoke(() => _tray.SetStatus(app));
        _assistant.Start();
        _hotkeys = new HotkeyService(() => _assistant.OpenAssistant(rewrite: false));

        StartupRegistration.Apply(_settings.Current.StartWithWindows);

        if (!e.Args.Contains("--background"))
        {
            OpenEditor();
            _tray.Notify("WriteMind is ready — no account or setup needed. It helps in Word, Outlook, Notepad and WhatsApp; press Ctrl+Alt+W for the assistant.");
        }
    }

    private void OpenEditor()
    {
        if (_settings is null || _api is null || _checker is null) return;
        if (_editor is null || !_editor.IsLoaded)
        {
            _editor = new EditorWindow(_settings, _api, _checker);
            _editor.Closed += (_, _) => _editor = null;
        }
        _editor.Show();
        _editor.Activate();
    }

    private void OpenSettings()
    {
        if (_settings is null || _checker is null) return;
        if (_settingsWindow is null || !_settingsWindow.IsLoaded)
        {
            _settingsWindow = new SettingsWindow(_settings, _checker, ChangeApiUrl);
            _settingsWindow.Closed += (_, _) => _settingsWindow = null;
        }
        _settingsWindow.Show();
        _settingsWindow.Activate();
    }

    private void ChangeApiUrl(Uri uri)
    {
        // Restart so every component uses the new server consistently.
        if (Environment.ProcessPath is { } path)
        {
            System.Diagnostics.Process.Start(path, "--background");
            Quit();
        }
    }

    private void Quit()
    {
        _hotkeys?.Dispose();
        _assistant?.Dispose();
        _tray?.Dispose();
        _api?.Dispose();
        _showSignal?.Dispose();
        _instance?.Dispose();
        Shutdown();
    }
}
