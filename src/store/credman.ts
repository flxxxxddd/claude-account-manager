/**
 * Windows backend — Credential Manager via PowerShell P/Invoke into advapi32.
 *
 * Claude Code probes for Credential Manager (`isWindowsCredManagerAvailable`)
 * and falls back to the flat file when it is unavailable, so this backend
 * reports availability and the dispatcher mirrors that fallback.
 */
import { spawn } from "node:child_process";
import type { CredentialBlob, CredentialStore } from "./types.ts";

const PINVOKE = `
Add-Type -Namespace CcaNative -Name Cred -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredDeleteW(string target, uint type, uint flags);
[DllImport("advapi32.dll", SetLastError=true)]
public static extern void CredFree(IntPtr buffer);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
  public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
'@ -UsingNamespace System.Runtime.InteropServices
`;

function runPowerShell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.write(script);
    child.stdin.end();
  });
}

/** PowerShell string literal — single quotes, with internal quotes doubled. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const credmanStore: CredentialStore = {
  kind: "credman",

  async read({ service }) {
    const script = `${PINVOKE}
$ptr = [IntPtr]::Zero
if (-not [CcaNative.Cred]::CredReadW(${psQuote(service)}, 1, 0, [ref]$ptr)) { exit 2 }
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CcaNative.Cred+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[CcaNative.Cred]::CredFree($ptr)
[Console]::Out.Write([System.Text.Encoding]::Unicode.GetString($bytes))
`;
    const { code, stdout, stderr } = await runPowerShell(script);
    if (code === 2) return null;
    if (code !== 0) {
      throw new Error(`credential manager read failed: ${stderr.trim() || `exit ${code}`}`);
    }
    const raw = stdout.trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CredentialBlob;
    } catch {
      throw new Error(`credential ${service} does not contain valid JSON`);
    }
  },

  async write({ service, account }, blob) {
    // The secret travels over stdin as base64 so it never lands in argv.
    const b64 = Buffer.from(JSON.stringify(blob), "utf8").toString("base64");
    const script = `${PINVOKE}
$secret = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(b64)}))
$bytes = [System.Text.Encoding]::Unicode.GetBytes($secret)
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$cred = New-Object CcaNative.Cred+CREDENTIAL
$cred.Type = 1
$cred.TargetName = ${psQuote(service)}
$cred.UserName = ${psQuote(account)}
$cred.CredentialBlob = $ptr
$cred.CredentialBlobSize = $bytes.Length
$cred.Persist = 2
$ok = [CcaNative.Cred]::CredWriteW([ref]$cred, 0)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if (-not $ok) { exit 3 }
`;
    const { code, stderr } = await runPowerShell(script);
    if (code !== 0) {
      throw new Error(`credential manager write failed: ${stderr.trim() || `exit ${code}`}`);
    }
  },

  async remove({ service }) {
    const script = `${PINVOKE}
[void][CcaNative.Cred]::CredDeleteW(${psQuote(service)}, 1, 0)
`;
    await runPowerShell(script);
  },
};

export async function credmanAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { code } = await runPowerShell(`${PINVOKE}\nexit 0\n`);
    return code === 0;
  } catch {
    return false;
  }
}
