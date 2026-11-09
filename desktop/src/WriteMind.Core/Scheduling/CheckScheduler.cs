namespace WriteMind.Core.Scheduling;

/// <summary>
/// Two-tier debounce: a fast grammar check shortly after typing pauses and a full (AI-assisted) check
/// after a longer pause. Every change resets both timers. Callbacks run on the timer thread.
/// </summary>
public sealed class CheckScheduler : IDisposable
{
    private readonly Action<string> _run;
    private readonly Func<bool> _fullEnabled;
    private readonly TimeSpan _fastDelay;
    private readonly TimeSpan _fullDelay;
    private readonly ITimer _fast;
    private readonly ITimer _full;

    public CheckScheduler(Action<string> run, Func<bool> fullEnabled, TimeProvider? time = null,
        TimeSpan? fastDelay = null, TimeSpan? fullDelay = null)
    {
        _run = run;
        _fullEnabled = fullEnabled;
        _fastDelay = fastDelay ?? TimeSpan.FromMilliseconds(350);
        _fullDelay = fullDelay ?? TimeSpan.FromMilliseconds(1500);
        var provider = time ?? TimeProvider.System;
        _fast = provider.CreateTimer(_ => _run("fast"), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        _full = provider.CreateTimer(_ => _run("full"), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void Poke(bool immediate = false)
    {
        _fast.Change(immediate ? TimeSpan.Zero : _fastDelay, Timeout.InfiniteTimeSpan);
        _full.Change(_fullEnabled() ? _fullDelay : Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void Cancel()
    {
        _fast.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        _full.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void Dispose()
    {
        _fast.Dispose();
        _full.Dispose();
    }
}
