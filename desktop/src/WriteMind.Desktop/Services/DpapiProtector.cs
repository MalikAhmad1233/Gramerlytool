using System.Security.Cryptography;
using WriteMind.Core.Settings;

namespace WriteMind.Desktop.Services;

/// <summary>Encrypts the stored session with the Windows user's DPAPI key (CurrentUser scope).</summary>
internal sealed class DpapiProtector : ISecretProtector
{
    private static readonly byte[] Entropy = "WriteMind.Desktop.Session.v1"u8.ToArray();

    public byte[] Protect(byte[] plain) => ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);

    public byte[] Unprotect(byte[] cipher) => ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.CurrentUser);
}
