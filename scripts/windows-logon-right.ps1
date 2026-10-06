# Grants or removes one account right in the local security policy. Run elevated.
# The Windows smoke's fixture user starts its task with a Password logon, which is
# a batch logon, and Users do not hold SeBatchLogonRight on Windows Server (#1683).
if (-not ('AgentHarnessSmoke.LogonRights' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace AgentHarnessSmoke {
  public static class LogonRights {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LsaUnicodeString { public ushort Length; public ushort MaximumLength; public string Buffer; }

    [StructLayout(LayoutKind.Sequential)]
    struct LsaObjectAttributes {
      public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes;
      public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
    }

    const uint PolicyCreateAccount = 0x10;
    const uint PolicyLookupNames = 0x800;

    [DllImport("advapi32.dll")]
    static extern uint LsaOpenPolicy(IntPtr systemName, ref LsaObjectAttributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")]
    static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaUnicodeString[] rights, uint count);
    [DllImport("advapi32.dll")]
    static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool allRights, LsaUnicodeString[] rights, uint count);
    [DllImport("advapi32.dll")]
    static extern uint LsaClose(IntPtr policy);
    [DllImport("advapi32.dll")]
    static extern int LsaNtStatusToWinError(uint status);

    public static void Grant(string sid, string right) { Change(sid, right, true); }
    public static void Revoke(string sid, string right) { Change(sid, right, false); }

    static void Change(string sid, string right, bool grant) {
      var identifier = new SecurityIdentifier(sid);
      var binary = new byte[identifier.BinaryLength];
      identifier.GetBinaryForm(binary, 0);
      var attributes = new LsaObjectAttributes { Length = Marshal.SizeOf(typeof(LsaObjectAttributes)) };
      IntPtr policy;
      Check(LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyCreateAccount | PolicyLookupNames, out policy));
      try {
        var rights = new[] { new LsaUnicodeString { Buffer = right, Length = (ushort)(right.Length * 2), MaximumLength = (ushort)((right.Length + 1) * 2) } };
        Check(grant ? LsaAddAccountRights(policy, binary, rights, 1) : LsaRemoveAccountRights(policy, binary, false, rights, 1));
      } finally { LsaClose(policy); }
    }

    static void Check(uint status) {
      if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    }
  }
}
'@
}

function Grant-WindowsLogonRight {
  param([Parameter(Mandatory)][string] $Sid, [Parameter(Mandatory)][string] $Right)
  [AgentHarnessSmoke.LogonRights]::Grant($Sid, $Right)
}

function Revoke-WindowsLogonRight {
  param([Parameter(Mandatory)][string] $Sid, [Parameter(Mandatory)][string] $Right)
  [AgentHarnessSmoke.LogonRights]::Revoke($Sid, $Right)
}
