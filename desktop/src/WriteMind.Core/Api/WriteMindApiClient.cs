using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace WriteMind.Core.Api;

public sealed class WriteMindApiException(string code, string message, HttpStatusCode? status = null)
    : Exception(message)
{
    public string Code { get; } = code;
    public HttpStatusCode? Status { get; } = status;
    public bool IsOffline => Code is "offline" or "timeout";
}

/// <summary>Persisted session (tokens are protected at rest by the platform layer).</summary>
public sealed record AuthSession(string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt, UserInfo User);

public interface ISessionStore
{
    AuthSession? Load();
    void Save(AuthSession? session);
}

/// <summary>
/// Typed client for the WriteMind API. Thread-safe; one instance per application.
/// Access tokens are refreshed transparently (single-flight); a rejected refresh signs the user out.
/// </summary>
public sealed class WriteMindApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly ISessionStore _sessions;
    private readonly TimeProvider _time;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private AuthSession? _session;

    public WriteMindApiClient(Uri baseAddress, ISessionStore sessions, HttpMessageHandler? handler = null, TimeProvider? time = null)
    {
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.BaseAddress = baseAddress;
        _http.Timeout = TimeSpan.FromSeconds(10);
        _http.DefaultRequestHeaders.Add("X-WriteMind-Client", "windows-desktop");
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("WriteMindDesktop", "1.0"));
        _sessions = sessions;
        _time = time ?? TimeProvider.System;
        _session = sessions.Load();
    }

    public UserInfo? CurrentUser => _session?.User;

    public event EventHandler? SessionChanged;

    public Task<CheckResponse> CheckAsync(CheckRequest request, CancellationToken ct = default) =>
        SendAsync<CheckResponse>(HttpMethod.Post, "/v1/check", request, AuthMode.Optional, ct);

    public Task<RewriteResponse> RewriteAsync(RewriteRequest request, CancellationToken ct = default) =>
        SendAsync<RewriteResponse>(HttpMethod.Post, "/v1/rewrite", request, AuthMode.Optional, ct);

    public Task<MetaInfo> MetaAsync(CancellationToken ct = default) =>
        SendAsync<MetaInfo>(HttpMethod.Get, "/v1/meta", null, AuthMode.None, ct);

    public async Task<UserInfo> LoginAsync(string email, string password, CancellationToken ct = default)
    {
        var pair = await SendAsync<TokenPair>(HttpMethod.Post, "/v1/auth/login",
            new { email, password, client = "windows-desktop" }, AuthMode.None, ct);
        SetSession(pair);
        return pair.User;
    }

    public async Task<UserInfo> RegisterAsync(string email, string password, string? displayName, CancellationToken ct = default)
    {
        var pair = await SendAsync<TokenPair>(HttpMethod.Post, "/v1/auth/register",
            new { email, password, display_name = displayName, client = "windows-desktop" }, AuthMode.None, ct);
        SetSession(pair);
        return pair.User;
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        var session = _session;
        if (session is not null)
        {
            try
            {
                await SendAsync<object?>(HttpMethod.Post, "/v1/auth/logout",
                    new { refresh_token = session.RefreshToken }, AuthMode.None, ct);
            }
            catch (WriteMindApiException)
            {
                // Signing out locally must work offline too.
            }
        }
        ClearSession();
    }

    public Task<RemoteSettings> GetSettingsAsync(CancellationToken ct = default) =>
        SendAsync<RemoteSettings>(HttpMethod.Get, "/v1/settings", null, AuthMode.Required, ct);

    public Task<RemoteSettings> PutSettingsAsync(object patch, CancellationToken ct = default) =>
        SendAsync<RemoteSettings>(HttpMethod.Put, "/v1/settings", patch, AuthMode.Required, ct);

    public Task<DictionaryResponse> GetDictionaryAsync(CancellationToken ct = default) =>
        SendAsync<DictionaryResponse>(HttpMethod.Get, "/v1/dictionary", null, AuthMode.Required, ct);

    public Task<DictionaryResponse> AddWordAsync(string word, CancellationToken ct = default) =>
        SendAsync<DictionaryResponse>(HttpMethod.Post, "/v1/dictionary", new { word }, AuthMode.Required, ct);

    public Task RemoveWordAsync(string word, CancellationToken ct = default) =>
        SendAsync<object?>(HttpMethod.Delete, $"/v1/dictionary/{Uri.EscapeDataString(word)}", null, AuthMode.Required, ct);

    public Task SendFeedbackAsync(IReadOnlyList<FeedbackEvent> events, CancellationToken ct = default) =>
        SendAsync<object?>(HttpMethod.Post, "/v1/feedback", new { client = "windows-desktop", events }, AuthMode.Optional, ct);

    public Task<UsageSummary> UsageAsync(int days = 7, CancellationToken ct = default) =>
        SendAsync<UsageSummary>(HttpMethod.Get, $"/v1/usage/summary?days={days}", null, AuthMode.Required, ct);

    private enum AuthMode { None, Optional, Required }

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, AuthMode auth, CancellationToken ct)
    {
        var session = auth == AuthMode.None ? null : _session;
        if (auth == AuthMode.Required && session is null) throw SignInRequired();
        if (session is not null && session.ExpiresAt - _time.GetUtcNow() < TimeSpan.FromSeconds(30))
        {
            session = await RefreshAsync(session, ct);
            if (session is null && auth == AuthMode.Required) throw SignInRequired();
        }

        using var response = await SendOnceAsync(method, path, body, session?.AccessToken, ct);
        if (response.StatusCode == HttpStatusCode.Unauthorized && session is not null)
        {
            var renewed = await RefreshAsync(session, ct);
            if (renewed is null && auth == AuthMode.Required) throw SignInRequired();
            using var retry = await SendOnceAsync(method, path, body, renewed?.AccessToken, ct);
            return await ReadAsync<T>(retry, ct);
        }
        return await ReadAsync<T>(response, ct);
    }

    private static WriteMindApiException SignInRequired() =>
        new("unauthorized", "Your session ended. Please sign in again.", HttpStatusCode.Unauthorized);

    private async Task<HttpResponseMessage> SendOnceAsync(HttpMethod method, string path, object? body, string? token, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = JsonContent.Create(body, body.GetType(), options: Json.Options);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        try
        {
            return await _http.SendAsync(request, ct);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new WriteMindApiException("timeout", "WriteMind took too long to respond.");
        }
        catch (HttpRequestException ex)
        {
            throw new WriteMindApiException("offline", $"Cannot reach the WriteMind service ({ex.Message}).");
        }
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode)
        {
            if (response.StatusCode == HttpStatusCode.NoContent || response.Content.Headers.ContentLength == 0) return default!;
            return (await response.Content.ReadFromJsonAsync<T>(Json.Options, ct))!;
        }
        ErrorEnvelope? envelope = null;
        try
        {
            envelope = await response.Content.ReadFromJsonAsync<ErrorEnvelope>(Json.Options, ct);
        }
        catch (System.Text.Json.JsonException)
        {
            // Non-JSON error bodies (proxies) fall through to the generic message.
        }
        throw new WriteMindApiException(
            envelope?.Error?.Code ?? $"http_{(int)response.StatusCode}",
            envelope?.Error?.Message ?? $"Request failed ({(int)response.StatusCode}).",
            response.StatusCode);
    }

    private async Task<AuthSession?> RefreshAsync(AuthSession stale, CancellationToken ct)
    {
        await _refreshLock.WaitAsync(ct);
        try
        {
            if (_session is null) return null;
            if (!ReferenceEquals(_session, stale) && _session.ExpiresAt - _time.GetUtcNow() > TimeSpan.FromSeconds(30))
                return _session; // another caller refreshed already
            using var response = await SendOnceAsync(HttpMethod.Post, "/v1/auth/refresh",
                new { refresh_token = _session.RefreshToken }, null, ct);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                ClearSession();
                return null;
            }
            if (!response.IsSuccessStatusCode) return _session;
            var pair = await response.Content.ReadFromJsonAsync<TokenPair>(Json.Options, ct);
            if (pair is null) return _session;
            SetSession(pair);
            return _session;
        }
        catch (WriteMindApiException)
        {
            return _session; // offline: keep the session and try later
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private void SetSession(TokenPair pair)
    {
        _session = new AuthSession(pair.AccessToken, pair.RefreshToken, _time.GetUtcNow().AddSeconds(pair.ExpiresIn), pair.User);
        _sessions.Save(_session);
        SessionChanged?.Invoke(this, EventArgs.Empty);
    }

    private void ClearSession()
    {
        _session = null;
        _sessions.Save(null);
        SessionChanged?.Invoke(this, EventArgs.Empty);
    }

    public void Dispose()
    {
        _http.Dispose();
        _refreshLock.Dispose();
    }
}
