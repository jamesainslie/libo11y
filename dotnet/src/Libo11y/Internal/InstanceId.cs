using System.Security.Cryptography;
using System.Text;

namespace Libo11y.Internal;

public static class InstanceId
{
    private static readonly byte[] NamespaceBytes = Convert.FromHexString("4d63009a8d0f11eeaad74c796ed8e320");

    public static string UuidV5(string name)
    {
        byte[] nameBytes = Encoding.UTF8.GetBytes(name);
        byte[] input = new byte[NamespaceBytes.Length + nameBytes.Length];
        Buffer.BlockCopy(NamespaceBytes, 0, input, 0, NamespaceBytes.Length);
        Buffer.BlockCopy(nameBytes, 0, input, NamespaceBytes.Length, nameBytes.Length);

        byte[] hash = SHA1.HashData(input);
        byte[] bytes = new byte[16];
        Buffer.BlockCopy(hash, 0, bytes, 0, 16);

        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

        string hex = Convert.ToHexString(bytes).ToLowerInvariant();
        return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..32]}";
    }

    public static string? Derive(string podUid = "", string podName = "", string k8sNamespace = "")
    {
        if (!string.IsNullOrEmpty(podUid))
        {
            return UuidV5(podUid);
        }
        if (!string.IsNullOrEmpty(podName))
        {
            return UuidV5($"{k8sNamespace}/{podName}");
        }
        return null;
    }

    public static string Random() => Guid.NewGuid().ToString("D");
}
