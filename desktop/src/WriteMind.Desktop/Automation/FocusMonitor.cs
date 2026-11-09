using System.Windows.Automation;
using Uia = System.Windows.Automation.Automation;

namespace WriteMind.Desktop.Automation;

/// <summary>
/// Observes which control has keyboard focus via UI Automation focus events. This reports *which element*
/// is focused — never which keys are pressed.
/// </summary>
internal sealed class FocusMonitor : IDisposable
{
    private readonly AutomationFocusChangedEventHandler _handler;
    private bool _started;

    public FocusMonitor() => _handler = OnFocusChanged;

    public event EventHandler<AutomationElement>? FocusChanged;

    public void Start()
    {
        if (_started) return;
        Uia.AddAutomationFocusChangedEventHandler(_handler);
        _started = true;
    }

    private void OnFocusChanged(object sender, AutomationFocusChangedEventArgs e)
    {
        if (sender is AutomationElement element) FocusChanged?.Invoke(this, element);
    }

    public void Dispose()
    {
        if (!_started) return;
        Uia.RemoveAutomationFocusChangedEventHandler(_handler);
        _started = false;
    }
}
