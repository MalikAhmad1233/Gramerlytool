using WriteMind.Core.Api;

namespace WriteMind.Core.Text;

public sealed record SuggestionFilters(
    IReadOnlySet<string> Dictionary,
    IReadOnlySet<string> DisabledRules,
    IReadOnlySet<string> Categories);

/// <summary>
/// Suggestion state for one text field (same semantics as the Chrome extension's store):
/// local edits rebase immediately, responses for older text are rebased rather than applied blindly,
/// and AI findings from the last full check survive subsequent fast checks unless overlapped.
/// Thread-safe.
/// </summary>
public sealed class SuggestionTracker
{
    private readonly Func<SuggestionFilters> _filters;
    private readonly HashSet<string> _ignored = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private IReadOnlyList<Suggestion> _list = [];
    private IReadOnlyList<Suggestion> _ai = [];

    public SuggestionTracker(Func<SuggestionFilters> filters) => _filters = filters;

    public string Text { get; private set; } = string.Empty;
    public int? Score { get; private set; }
    public int Words { get; private set; }

    public event EventHandler? Changed;

    public void SetText(string text)
    {
        lock (_gate)
        {
            if (string.Equals(text, Text, StringComparison.Ordinal)) return;
            var previous = Text;
            Text = text;
            _list = TextDiff.Rebase(_list, previous, text);
            _ai = TextDiff.Rebase(_ai, previous, text);
            if (string.IsNullOrWhiteSpace(text))
            {
                _list = [];
                _ai = [];
                Score = null;
                Words = 0;
            }
        }
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Apply(string sentText, CheckResponse response)
    {
        lock (_gate)
        {
            var incoming = string.Equals(sentText, Text, StringComparison.Ordinal)
                ? response.Suggestions
                : TextDiff.Rebase(response.Suggestions, sentText, Text);
            if (response.Mode == "full")
            {
                _ai = incoming.Where(s => s.Source == "ai").ToList();
                _list = incoming;
            }
            else
            {
                var keptAi = _ai.Where(a => !incoming.Any(b => TextDiff.Overlaps(a, b)));
                _list = incoming.Concat(keptAi).OrderBy(s => s.Offset).ToList();
            }
            Score = response.Stats.Score;
            Words = response.Stats.Words;
        }
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public IReadOnlyList<Suggestion> Visible()
    {
        var f = _filters();
        lock (_gate)
        {
            return _list.Where(s =>
                !_ignored.Contains(s.Fingerprint) &&
                !f.DisabledRules.Contains(s.RuleId) &&
                f.Categories.Contains(s.Category) &&
                !(s.Category == Categories.Spelling && f.Dictionary.Contains(s.Original.Trim().ToLowerInvariant())))
                .ToList();
        }
    }

    public Suggestion? Find(string id)
    {
        lock (_gate) return _list.FirstOrDefault(s => s.Id == id);
    }

    public void Ignore(Suggestion s)
    {
        lock (_gate) _ignored.Add(s.Fingerprint);
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Remove(string id)
    {
        lock (_gate)
        {
            _list = _list.Where(s => s.Id != id).ToList();
            _ai = _ai.Where(s => s.Id != id).ToList();
        }
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Refresh() => Changed?.Invoke(this, EventArgs.Empty);
}
