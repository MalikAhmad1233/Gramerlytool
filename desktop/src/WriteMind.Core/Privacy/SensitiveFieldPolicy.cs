using System.Text.RegularExpressions;

namespace WriteMind.Core.Privacy;

/// <summary>What the platform layer knows about a focused control, gathered *before* reading any text.</summary>
public sealed record FieldDescriptor
{
    public required string ProcessName { get; init; }
    public string ControlType { get; init; } = "Edit"; // UIA ControlType programmatic name, e.g. "Edit", "Document"
    public string ClassName { get; init; } = "";
    public string Name { get; init; } = "";
    public string AutomationId { get; init; } = "";
    public bool IsPassword { get; init; }
    public bool IsReadOnly { get; init; }
    public bool IsEnabled { get; init; } = true;
    public bool HasTextPattern { get; init; }
    public bool HasValuePattern { get; init; }
    public bool IsOwnProcess { get; init; }
}

public enum FieldDecision
{
    Eligible,
    NotEditable,
    Password,
    SensitiveName,
    BlockedApp,
    BrowserHandledByExtension,
    DisabledByUser,
    OwnWindow,
}

/// <summary>
/// Privacy rule R3 for Windows: password and sensitive fields are never read; password managers,
/// terminals and similar apps are never touched; browsers are left to the Chrome extension.
/// </summary>
public static partial class SensitiveFieldPolicy
{
    [GeneratedRegex(
        @"pass(word|wd|code|phrase)?|pwd|secret|token|otp|one.?time|2fa|mfa|totp|\bpin\b|cvv|cvc|csc|ssn|social.?sec|" +
        @"tax.?id|iban|swift|card.?(number|no)|account.?(number|no)|routing|api.?key|private.?key|seed.?phrase|mnemonic",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SensitiveName();

    public static FieldDecision Evaluate(FieldDescriptor field, AppCatalog catalog, IReadOnlySet<string> disabledApps)
    {
        if (field.IsOwnProcess) return FieldDecision.OwnWindow;
        if (field.IsPassword) return FieldDecision.Password;
        var app = catalog.Resolve(field.ProcessName);
        if (app.Kind == AppKind.Blocked) return FieldDecision.BlockedApp;
        if (app.Kind == AppKind.Browser) return FieldDecision.BrowserHandledByExtension;
        if (disabledApps.Contains(field.ProcessName.ToLowerInvariant())) return FieldDecision.DisabledByUser;
        if (!field.IsEnabled || field.IsReadOnly) return FieldDecision.NotEditable;
        if (!field.HasTextPattern && !field.HasValuePattern) return FieldDecision.NotEditable;
        if (field.ControlType is not ("Edit" or "Document" or "Custom" or "Pane" or "Text")) return FieldDecision.NotEditable;
        if (SensitiveName().IsMatch($"{field.Name} {field.AutomationId} {field.ClassName}")) return FieldDecision.SensitiveName;
        return FieldDecision.Eligible;
    }
}
