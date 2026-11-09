using Forms = System.Windows.Forms;

namespace WriteMind.Desktop.Services;

/// <summary>System-tray presence: status, pause/resume, editor, assistant, settings, quit.</summary>
internal sealed class TrayIcon : IDisposable
{
    private readonly Forms.NotifyIcon _icon;
    private readonly Forms.ToolStripMenuItem _pauseItem;
    private readonly Action<TimeSpan> _pause;
    private readonly Action _resume;
    private bool _paused;

    public TrayIcon(Action openEditor, Action openAssistant, Action openSettings, Action<TimeSpan> pause, Action resume, Action quit)
    {
        _pause = pause;
        _resume = resume;
        // Embedded so the icon survives single-file publishing.
        using var iconStream = typeof(TrayIcon).Assembly.GetManifestResourceStream("WriteMind.Desktop.writemind.ico");
        _icon = new Forms.NotifyIcon
        {
            Icon = iconStream is null ? System.Drawing.SystemIcons.Application : new System.Drawing.Icon(iconStream),
            Text = "WriteMind AI",
            Visible = true,
        };
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open WriteMind Editor", null, (_, _) => openEditor());
        menu.Items.Add("Open assistant  (Ctrl+Alt+W)", null, (_, _) => openAssistant());
        menu.Items.Add(new Forms.ToolStripSeparator());
        _pauseItem = new Forms.ToolStripMenuItem("Pause for 30 minutes", null, (_, _) => TogglePause());
        menu.Items.Add(_pauseItem);
        menu.Items.Add("Settings…", null, (_, _) => openSettings());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Quit WriteMind", null, (_, _) => quit());
        _icon.ContextMenuStrip = menu;
        _icon.DoubleClick += (_, _) => openEditor();
    }

    private void TogglePause()
    {
        _paused = !_paused;
        if (_paused) _pause(TimeSpan.FromMinutes(30));
        else _resume();
        _pauseItem.Text = _paused ? "Resume WriteMind" : "Pause for 30 minutes";
    }

    public void SetStatus(string? activeApp)
    {
        var text = activeApp is null ? "WriteMind AI — ready" : $"WriteMind AI — helping in {activeApp}";
        _icon.Text = text.Length > 63 ? text[..63] : text; // NotifyIcon limit
    }

    public void Notify(string message) => _icon.ShowBalloonTip(4000, "WriteMind AI", message, Forms.ToolTipIcon.None);

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}
