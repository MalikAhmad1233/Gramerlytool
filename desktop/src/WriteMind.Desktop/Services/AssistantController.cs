using System.Windows;
using System.Windows.Automation;
using Uia = System.Windows.Automation.Automation;
using System.Windows.Threading;
using WriteMind.Core.Api;
using WriteMind.Core.Offline;
using WriteMind.Core.Privacy;
using WriteMind.Core.Scheduling;
using WriteMind.Core.Settings;
using WriteMind.Core.Text;
using WriteMind.Desktop.Automation;
using WriteMind.Desktop.Interop;
using WriteMind.Desktop.Overlay;

namespace WriteMind.Desktop.Services;

/// <summary>State for the text control currently being assisted.</summary>
internal sealed class FieldSession : IDisposable
{
    public FieldSession(TextControlAccessor accessor, AppProfile app, SuggestionTracker tracker)
    {
        Accessor = accessor;
        App = app;
        Tracker = tracker;
    }

    public TextControlAccessor Accessor { get; }
    public AppProfile App { get; }
    public SuggestionTracker Tracker { get; }
    public CheckScheduler? Scheduler { get; set; }
    public TextSnapshot? Snapshot { get; set; }
    /// <summary>A check of the current text completed successfully.</summary>
    public bool Checked { get; set; }
    /// <summary>The last check failed (shown as an error, never as "no issues").</summary>
    public bool Failed { get; set; }
    public Rect Bounds { get; set; } = Rect.Empty;
    public CancellationTokenSource FastCts { get; set; } = new();
    public CancellationTokenSource FullCts { get; set; } = new();

    public void Dispose()
    {
        Scheduler?.Dispose();
        FastCts.Cancel();
        FullCts.Cancel();
        FastCts.Dispose();
        FullCts.Dispose();
    }
}

/// <summary>
/// Writing assistance for other Windows applications (Word, Outlook, Notepad, WhatsApp, …).
/// Reads the focused control's text through UI Automation when it changes, checks it, draws underlines,
/// and edits the document only when the user clicks Accept or Replace.
/// </summary>
internal sealed class AssistantController : IDisposable
{
    private const int MaxChars = 20_000;
    private const int MaxUnderlines = 60;

    private readonly SettingsStore _settings;
    private readonly WriteMindApiClient _api;
    private readonly HybridChecker _checker;
    private readonly Dispatcher _ui;
    private readonly FocusMonitor _focus = new();
    private readonly SemaphoreSlim _uia = new(1, 1);
    private readonly int _ownPid = Environment.ProcessId;
    private readonly DispatcherTimer _hoverTimer;
    private Timer? _poll;
    private UnderlineOverlay? _overlay;
    private BadgeWindow? _badge;
    private SuggestionPopup? _popup;
    private AssistantWindow? _assistant;
    private FieldSession? _session;
    private IReadOnlyList<UnderlineItem> _items = [];
    private string? _hoveredId;
    private string? _hoverCandidate;
    private DateTime _hoverSince;
    private DateTime _lastOnPopupOrUnderline;
    private DateTimeOffset _pausedUntil = DateTimeOffset.MinValue;
    private (int Start, int End, string Source)? _rewrite;

    public AssistantController(SettingsStore settings, WriteMindApiClient api, HybridChecker checker, Dispatcher ui)
    {
        _settings = settings;
        _api = api;
        _checker = checker;
        _ui = ui;
        _hoverTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(60), DispatcherPriority.Input, (_, _) => OnHoverTick(), ui);
    }

    /// <summary>Raised with short user-facing messages (shown as tray notifications).</summary>
    public event EventHandler<string>? Notify;

    /// <summary>Raised when the assisted app changes ("Microsoft Word", or null when idle).</summary>
    public event EventHandler<string?>? ActiveAppChanged;

    public bool IsPaused => DateTimeOffset.UtcNow < _pausedUntil;

    public void Start()
    {
        _overlay = new UnderlineOverlay();
        _badge = new BadgeWindow();
        _badge.Clicked += (_, _) => OpenAssistant(rewrite: false);
        _popup = new SuggestionPopup();
        _popup.Card.AcceptRequested += (_, e) => Accept(e.Suggestion, e.Replacement);
        _popup.Card.IgnoreRequested += (_, s) => Ignore(s);
        _popup.Card.AddWordRequested += (_, s) => AddToDictionary(s);
        _popup.Card.DisableRuleRequested += (_, s) => DisableRule(s);
        _popup.Card.CloseRequested += (_, _) => _popup.Hide();
        _assistant = new AssistantWindow();
        var panel = _assistant.Panel;
        panel.AcceptRequested += (_, e) => Accept(e.Suggestion, e.Replacement);
        panel.IgnoreRequested += (_, s) => Ignore(s);
        panel.AddWordRequested += (_, s) => AddToDictionary(s);
        panel.DisableRuleRequested += (_, s) => DisableRule(s);
        panel.StyleChanged += (_, style) => SetStyle(style);
        panel.UseSelectionRequested += (_, _) => _ = PrepareRewriteAsync();
        panel.GenerateRequested += (_, style) => _ = GenerateRewriteAsync(style);
        panel.ReplaceRequested += (_, alt) => _ = ApplyRewriteAsync(alt);
        panel.SetStyle(_settings.Current.Style);

        _focus.FocusChanged += (_, element) => _ = Task.Run(() => OnFocusAsync(element));
        _focus.Start();
        _poll = new Timer(_ => _ = PollAsync(), null, TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(400));
        _hoverTimer.Start();
        _settings.Changed += (_, _) =>
        {
            if (!_settings.Current.Enabled) Detach();
            else _session?.Tracker.Refresh();
        };
    }

    public void Pause(TimeSpan duration)
    {
        _pausedUntil = DateTimeOffset.UtcNow + duration;
        Detach();
        Notify?.Invoke(this, $"WriteMind is paused for {duration.TotalMinutes:0} minutes.");
    }

    public void Resume() => _pausedUntil = DateTimeOffset.MinValue;

    // ----------------------------------------------------------------------------------- focus

    private async Task OnFocusAsync(AutomationElement element)
    {
        if (IsPaused || !_settings.Current.Enabled) return;
        await _uia.WaitAsync();
        try
        {
            var accessor = TextControlAccessor.TryCreate(element);
            if (accessor is null) return;
            if (accessor.ProcessId == _ownPid) return; // our own windows (popup/assistant) keep the session alive

            var settings = _settings.Current;
            var catalog = new AppCatalog();
            var decision = SensitiveFieldPolicy.Evaluate(accessor.Describe(_ownPid), catalog, settings.DisabledAppSet());
            var app = catalog.Resolve(accessor.ProcessName);
            if (decision == FieldDecision.Eligible && app.Kind == AppKind.Generic && !settings.CheckGenericApps)
                decision = FieldDecision.DisabledByUser;

            if (decision != FieldDecision.Eligible)
            {
                // Privacy first: leaving for a password box (or any ineligible control) ends the session immediately.
                if (decision is FieldDecision.Password or FieldDecision.SensitiveName || _session?.Accessor.ProcessId != accessor.ProcessId)
                    Detach();
                return;
            }
            if (_session is not null && Uia.Compare(_session.Accessor.Element, element)) return;
            Attach(accessor, app);
        }
        catch (ElementNotAvailableException)
        {
        }
        finally
        {
            _uia.Release();
        }
    }

    private void Attach(TextControlAccessor accessor, AppProfile app)
    {
        DetachCore();
        var session = new FieldSession(accessor, app, new SuggestionTracker(() => _settings.Current.ToFilters()));
        session.Scheduler = new CheckScheduler(mode => _ = RunCheckAsync(session, mode), () => _settings.Current.AiEnabled);
        _session = session;
        var snapshot = accessor.Read(MaxChars);
        session.Snapshot = snapshot;
        session.Tracker.SetText(snapshot.Text);
        session.Scheduler.Poke(immediate: true);
        ActiveAppChanged?.Invoke(this, app.DisplayName);
    }

    private void Detach()
    {
        DetachCore();
        _ui.BeginInvoke(() =>
        {
            _overlay?.Hide();
            _badge?.Hide();
            _popup?.Hide();
        });
        ActiveAppChanged?.Invoke(this, null);
    }

    private void DetachCore()
    {
        var old = _session;
        _session = null;
        _items = [];
        old?.Dispose();
    }

    // ------------------------------------------------------------------------- read & render

    private async Task PollAsync()
    {
        var session = _session;
        if (session is null || !await _uia.WaitAsync(0)) return;
        try
        {
            if (IsPaused) return;
            var snapshot = session.Accessor.Read(MaxChars);
            if (!string.Equals(snapshot.Text, session.Tracker.Text, StringComparison.Ordinal))
            {
                session.Snapshot = snapshot;
                session.Tracker.SetText(snapshot.Text);
                session.Checked = false;
                session.Scheduler?.Poke();
            }
            session.Snapshot ??= snapshot;
            session.Bounds = session.Accessor.Bounds;

            var items = new List<UnderlineItem>();
            if (_settings.Current.ShowUnderlines && session.Accessor.HasGeometry)
            {
                foreach (var s in session.Tracker.Visible().Take(MaxUnderlines))
                {
                    var rects = session.Accessor.RectsFor(snapshot, s.Offset, s.Length, s.Original);
                    if (rects.Length > 0) items.Add(new UnderlineItem(s, rects));
                }
            }
            _items = items;
            var count = session.Tracker.Visible().Count;
            var hasText = !string.IsNullOrWhiteSpace(snapshot.Text);
            await _ui.InvokeAsync(() => Render(session, hasText, count));
        }
        catch (ElementNotAvailableException)
        {
            Detach();
        }
        catch (InvalidOperationException)
        {
            // Element went away mid-read; the next focus event re-establishes a session.
        }
        finally
        {
            _uia.Release();
        }
    }

    private void Render(FieldSession session, bool hasText, int count)
    {
        if (!ReferenceEquals(session, _session)) return;
        _overlay?.Render(session.Bounds, _items, _hoveredId);
        var state = session.Failed ? BadgeState.Error : session.Checked ? BadgeState.Ready : BadgeState.Checking;
        if (hasText && !session.Bounds.IsEmpty) _badge?.ShowAt(session.Bounds, count, state);
        else _badge?.Hide();
        if (_assistant?.IsVisible == true) RefreshAssistantList(session);
    }

    private void RefreshAssistantList(FieldSession session) =>
        _assistant?.Panel.SetSuggestions(session.Tracker.Visible(), session.Tracker.Score, session.Tracker.Words,
            _ => session.Accessor.HasGeometry || session.Accessor.IsClassicEdit);

    private void OnHoverTick()
    {
        var session = _session;
        if (session is null || _popup is null || !NativeMethods.GetCursorPos(out var p)) return;
        var point = new Point(p.X, p.Y);
        if (_popup.ContainsScreenPoint(point))
        {
            _lastOnPopupOrUnderline = DateTime.UtcNow;
            return;
        }
        var hit = _items.FirstOrDefault(i => i.Rects.Any(r => Rect.Inflate(r, 1, 3).Contains(point)));
        if (hit is not null)
        {
            _lastOnPopupOrUnderline = DateTime.UtcNow;
            if (_hoverCandidate != hit.Suggestion.Id)
            {
                _hoverCandidate = hit.Suggestion.Id;
                _hoverSince = DateTime.UtcNow;
            }
            if (_hoveredId != hit.Suggestion.Id && DateTime.UtcNow - _hoverSince > TimeSpan.FromMilliseconds(250))
            {
                _hoveredId = hit.Suggestion.Id;
                _overlay?.Render(session.Bounds, _items, _hoveredId);
                var canEdit = session.Accessor.HasGeometry || session.Accessor.IsClassicEdit;
                _popup.ShowFor(hit.Suggestion, canEdit, hit.Rects[0]);
            }
            return;
        }
        _hoverCandidate = null;
        if (_popup.IsVisible && DateTime.UtcNow - _lastOnPopupOrUnderline > TimeSpan.FromMilliseconds(700))
        {
            _popup.Hide();
            _hoveredId = null;
            _overlay?.Render(session.Bounds, _items, null);
        }
    }

    // ---------------------------------------------------------------------------------- check

    private async Task RunCheckAsync(FieldSession session, string mode)
    {
        var text = session.Tracker.Text;
        var settings = _settings.Current;
        if (string.IsNullOrWhiteSpace(text) || (mode == "full" && !settings.AiEnabled)) return;
        CancellationTokenSource cts;
        if (mode == "fast")
        {
            await session.FastCts.CancelAsync();
            session.FastCts = cts = new CancellationTokenSource();
        }
        else
        {
            await session.FullCts.CancelAsync();
            session.FullCts = cts = new CancellationTokenSource();
        }
        try
        {
            var response = await _checker.CheckAsync(new CheckRequest
            {
                Text = text,
                Mode = mode,
                Language = settings.Language,
                Style = settings.Style,
                Client = new ClientContext("windows-desktop", session.App.AppId),
                Dictionary = settings.Dictionary,
                DisabledRules = settings.DisabledRules,
                Ai = settings.AiEnabled,
            }, cts.Token);
            if (!ReferenceEquals(session, _session)) return;
            session.Tracker.Apply(text, response);
            session.Failed = false;
            if (string.Equals(text, session.Tracker.Text, StringComparison.Ordinal)) session.Checked = true;
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception)
        {
            session.Failed = true;
        }
        _ = PollAsync(); // re-render promptly with fresh geometry
    }

    // -------------------------------------------------------------------------------- actions

    /// <summary>Anonymous quality signal (rule id + action, never text); only sent when a server is in use.</summary>
    private void SendFeedback(Suggestion s, string action)
    {
        if (!_checker.UsingServer) return;
        _ = _api.SendFeedbackAsync([new FeedbackEvent(s.RuleId, s.Category, s.Source, action)]).ContinueWith(
            static t => _ = t.Exception, TaskScheduler.Default);
    }

    /// <summary>Writes into the user's document — only ever called from an Accept click.</summary>
    public void Accept(Suggestion suggestion, string replacement)
    {
        var session = _session;
        if (session is null) return;
        _popup?.Hide();
        _ = Task.Run(async () =>
        {
            ApplyOutcome outcome;
            await _uia.WaitAsync();
            try
            {
                outcome = await TextApplier.ApplyAsync(session.Accessor, suggestion.Offset, suggestion.Length, suggestion.Original,
                    replacement, wholeWords: true, MaxChars);
            }
            finally
            {
                _uia.Release();
            }
            HandleOutcome(session, outcome, replacement);
            if (outcome == ApplyOutcome.Applied)
            {
                SendFeedback(suggestion, "accepted");
                session.Tracker.Remove(suggestion.Id);
            }
            else if (outcome == ApplyOutcome.Stale)
            {
                session.Tracker.Remove(suggestion.Id);
                session.Scheduler?.Poke(immediate: true);
            }
            await PollAsync();
        });
    }

    private void HandleOutcome(FieldSession session, ApplyOutcome outcome, string replacement)
    {
        switch (outcome)
        {
            case ApplyOutcome.Applied:
                return;
            case ApplyOutcome.Stale:
                Notify?.Invoke(this, "The text changed before the correction could be applied — re-checking.");
                return;
            case ApplyOutcome.Elevated:
                Notify?.Invoke(this, $"{session.App.DisplayName} is running as administrator, so Windows blocks edits from WriteMind.");
                return;
            default:
                _ui.Invoke(() => Clipboard.SetText(replacement));
                Notify?.Invoke(this, $"{session.App.DisplayName} didn't accept the edit. “{replacement}” was copied — paste it over the highlighted text.");
                return;
        }
    }

    public void Ignore(Suggestion s)
    {
        _session?.Tracker.Ignore(s);
        SendFeedback(s, "ignored");
        _popup?.Hide();
        _ = PollAsync();
    }

    public void AddToDictionary(Suggestion s)
    {
        var word = s.Original.Trim();
        _settings.Update(c => c with { Dictionary = c.Dictionary.Append(word).Distinct(StringComparer.OrdinalIgnoreCase).ToList() });
        SendFeedback(s, "added_to_dictionary");
        _popup?.Hide();
        _ = PollAsync();
    }

    public void DisableRule(Suggestion s)
    {
        _settings.Update(c => c with { DisabledRules = c.DisabledRules.Append(s.RuleId).Distinct().ToList() });
        SendFeedback(s, "rule_disabled");
        _popup?.Hide();
        Notify?.Invoke(this, "Rule turned off. Re-enable it in Settings → Writing.");
        _ = PollAsync();
    }

    public void SetStyle(string style)
    {
        _settings.Update(c => c with { Style = style });
        _session?.Scheduler?.Poke(immediate: true);
    }

    public void OpenAssistant(bool rewrite)
    {
        _ui.BeginInvoke(() =>
        {
            if (_assistant is null) return;
            _assistant.Panel.SetStyle(_settings.Current.Style);
            _assistant.ShowDocked();
            if (_session is null)
            {
                _assistant.Panel.SetSuggestions([], null, 0, _ => false);
                Notify?.Invoke(this, "Click into a document or message box first, then open WriteMind.");
            }
            else
            {
                RefreshAssistantList(_session);
            }
            _assistant.Panel.ShowTab(rewrite);
        });
    }

    private async Task PrepareRewriteAsync()
    {
        var session = _session;
        if (session is null) return;
        await _uia.WaitAsync();
        try
        {
            var snapshot = session.Accessor.Read(MaxChars);
            session.Snapshot = snapshot;
            var selection = session.Accessor.Selection(snapshot);
            var (start, end) = selection is { } sel && sel.End > sel.Start
                ? sel
                : SentenceFinder.Around(snapshot.Text, selection?.Start ?? snapshot.Text.Length);
            var source = snapshot.Text[start..end];
            _rewrite = string.IsNullOrWhiteSpace(source) ? null : (start, end, source);
            await _ui.InvokeAsync(() => _assistant?.Panel.SetRewriteSource(source));
        }
        finally
        {
            _uia.Release();
        }
    }

    private async Task GenerateRewriteAsync(string style)
    {
        var rewrite = _rewrite;
        if (rewrite is null) return;
        var settings = _settings.Current;
        await _ui.InvokeAsync(() => _assistant?.Panel.SetRewriteBusy(true));
        try
        {
            var response = await _checker.RewriteAsync(new RewriteRequest
            {
                Text = rewrite.Value.Source,
                Style = style,
                Count = 3,
                Language = settings.Language,
                Client = new ClientContext("windows-desktop", _session?.App.AppId),
                Ai = settings.AiEnabled,
            });
            await _ui.InvokeAsync(() => _assistant?.Panel.SetAlternatives(response.Alternatives,
                response.Alternatives.Count == 0 ? "Your text already reads well in this style." : null));
        }
        catch (WriteMindApiException ex)
        {
            await _ui.InvokeAsync(() => _assistant?.Panel.SetAlternatives([], ex.Message));
        }
        finally
        {
            await _ui.InvokeAsync(() => _assistant?.Panel.SetRewriteBusy(false));
        }
    }

    private async Task ApplyRewriteAsync(RewriteAlternative alternative)
    {
        var session = _session;
        var rewrite = _rewrite;
        if (session is null || rewrite is null) return;
        ApplyOutcome outcome;
        await _uia.WaitAsync();
        try
        {
            var (start, end, source) = rewrite.Value;
            outcome = await TextApplier.ApplyAsync(session.Accessor, start, end - start, source, alternative.Text, wholeWords: false, MaxChars);
        }
        finally
        {
            _uia.Release();
        }
        HandleOutcome(session, outcome, alternative.Text);
        if (outcome == ApplyOutcome.Applied)
        {
            _rewrite = null;
            await _ui.InvokeAsync(() => _assistant?.Hide());
            Notify?.Invoke(this, "Rewrite applied. Press Ctrl+Z in your app to undo.");
        }
        await PollAsync();
    }

    public void Dispose()
    {
        _hoverTimer.Stop();
        _poll?.Dispose();
        _focus.Dispose();
        DetachCore();
        _uia.Dispose();
    }
}
