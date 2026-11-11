using WriteMind.Core.Api;

namespace WriteMind.Core.Offline;

/// <summary>
/// Uses a WriteMind server when one is reachable (full grammar engine, AI) and the built-in checker otherwise,
/// so the app always works — with no account and no server required.
/// </summary>
public sealed class HybridChecker
{
    private static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(30);
    private readonly WriteMindApiClient _api;
    private readonly TimeProvider _time;
    private DateTimeOffset _serverDownUntil = DateTimeOffset.MinValue;

    public HybridChecker(WriteMindApiClient api, TimeProvider? time = null)
    {
        _api = api;
        _time = time ?? TimeProvider.System;
    }

    /// <summary>True while the last attempt reached a WriteMind server.</summary>
    public bool UsingServer { get; private set; }

    public bool ServerHasAi { get; private set; }

    public event EventHandler? EngineChanged;

    private bool ShouldTryServer => _time.GetUtcNow() >= _serverDownUntil;

    private void Mark(bool server, bool? ai = null)
    {
        if (!server) _serverDownUntil = _time.GetUtcNow() + RetryAfter;
        var changed = UsingServer != server;
        UsingServer = server;
        if (ai is not null) ServerHasAi = ai.Value && server;
        if (changed) EngineChanged?.Invoke(this, EventArgs.Empty);
    }

    public async Task<CheckResponse> CheckAsync(CheckRequest request, CancellationToken ct = default)
    {
        if (ShouldTryServer)
        {
            try
            {
                var response = await _api.CheckAsync(request, ct);
                Mark(true, response.Engine.Ai != "unavailable");
                return response;
            }
            catch (WriteMindApiException ex) when (ex.IsOffline || (int?)ex.Status >= 500)
            {
                Mark(false);
            }
        }
        ct.ThrowIfCancellationRequested();
        return await Task.Run(() => OfflineEngine.Check(request.Text,
            new OfflineOptions(request.Language, request.Style, request.Client.App, request.Mode, request.Dictionary),
            Speller.For(request.Language)), ct);
    }

    public async Task<RewriteResponse> RewriteAsync(RewriteRequest request, CancellationToken ct = default)
    {
        if (ShouldTryServer)
        {
            try
            {
                var response = await _api.RewriteAsync(request, ct);
                Mark(true);
                return response;
            }
            catch (WriteMindApiException ex) when (ex.IsOffline || (int?)ex.Status >= 500)
            {
                Mark(false);
            }
        }
        return await Task.Run(() => OfflineRewriter.Rewrite(request.Text, request.Style, request.Count, request.Language,
            Speller.For(request.Language)), ct);
    }

    /// <summary>Probes the server now (used by Settings to show which engine is active).</summary>
    public async Task<bool> RefreshAsync(CancellationToken ct = default)
    {
        try
        {
            var meta = await _api.MetaAsync(ct);
            _serverDownUntil = DateTimeOffset.MinValue;
            Mark(true, meta.AiAvailable);
        }
        catch (WriteMindApiException)
        {
            Mark(false);
        }
        return UsingServer;
    }
}
