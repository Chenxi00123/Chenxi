/**
 * windows-job 包装进程的**源码模板**（ADR-031 / 兑现 ADR-027 修订的 Windows 真围栏）。
 *
 * 为什么把 C# 与 ps1 **内嵌成字符串**而不是放成资产文件：
 *  - 本仓的 `bin/aster.mjs` 是**单文件 bundle**，资产文件在打包形态下找不到；
 *  - 内嵌后 esbuild 直接把它**打进单文件**，零资产解析问题（零新依赖、零外部文件）。
 *
 * 载体为什么是**内盒 PowerShell + `Add-Type`**（而不是 native binding）：
 *  - 本机实测 `Add-Type`（.NET Framework 内盒编译器）**可用**，能 P/Invoke 任意 Win32；
 *  - 仓库供应链纪律禁止新增带二进制的依赖（`05 §1` / ADR-029 增补 ③），且本机 GitHub 源下不来。
 *
 * ⚠️ 两份源码都**只用 ASCII 引号与转义**（用 `String.raw` 保留反斜杠）：避免 TS 模板字符串吞掉转义。
 * ps1 落盘时**带 UTF-8 BOM**（PowerShell 5.1 无 BOM 会按 ANSI 读 ⇒ 中文注释会变乱码并可能破坏语法，M15 实测踩过）。
 */

/** Win32 P/Invoke（作业对象 + 挂起创建 + 继承 std handle）；只做产品真正用到的那些。 */
export const JOB_WIN32_CS = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AsterJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_UI_RESTRICTIONS { public uint UIRestrictionsClass; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  public const int JobObjectExtendedLimitInformation = 9;
  public const int JobObjectBasicUIRestrictions = 4;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0008;
  public const uint CREATE_SUSPENDED = 0x00000004;
  public const uint CREATE_NO_WINDOW = 0x08000000;
  public const uint INFINITE = 0xFFFFFFFF;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cb);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_BASIC_UI_RESTRICTIONS info, uint cb);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);

  static uint ExtSize() { return (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); }
  static uint UiSize() { return (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_UI_RESTRICTIONS)); }

  /** 建作业（关句柄即整树击杀 + 进程数上限 + UI 限制）；任何一步失败都抛 ⇒ 调用方按"拒绝执行"处理。 */
  public static IntPtr CreateFencedJob(uint processLimit, uint uiFlags) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW");
    var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (processLimit > 0) {
      ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
      ext.BasicLimitInformation.ActiveProcessLimit = processLimit;
    }
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref ext, ExtSize())) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(Extended)");
    }
    if (uiFlags != 0) {
      var ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS();
      ui.UIRestrictionsClass = uiFlags;
      if (!SetInformationJobObject(job, JobObjectBasicUIRestrictions, ref ui, UiSize())) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(UI)");
      }
    }
    return job;
  }

  /** 挂起创建内层进程 -> 入作业 -> 恢复 -> 等它结束（stdio 继承包装进程的管道）。返回内层退出码。 */
  public static int RunInJob(IntPtr job, string innerExe, string innerArgs) {
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
    si.hStdInput = GetStdHandle(-10);
    si.hStdOutput = GetStdHandle(-11);
    si.hStdError = GetStdHandle(-12);

    string cmd = "\"" + innerExe + "\" " + innerArgs;
    PROCESS_INFORMATION pi;
    // lpApplicationName **传 null**：内层 exe 可能是裸名（pwsh / powershell 这种），
    // 而这个参数**不走 PATH 搜索**（实测 err=2）⇒ 交给命令行解析（第一段已加引号）才能按 PATH 找到。
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_NO_WINDOW | CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi)) {
      int err = Marshal.GetLastWin32Error();
      throw new Win32Exception(err, "CreateProcessW err=" + err + " exe=" + innerExe);
    }
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      throw new Win32Exception(err, "AssignProcessToJobObject err=" + err);
    }
    if (ResumeThread(pi.hThread) == INFINITE) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      throw new Win32Exception(err, "ResumeThread err=" + err);
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    return (int)code;
  }
}
`;

/**
 * 包装进程脚本（ASCII 引号 + 中文注释；落盘时由调用方加 BOM）。
 *
 * 纪律：**拿不到围栏就拒绝执行**（stderr 可读原因 + exit 126），绝不静默退回"没围栏也跑"。
 * 内层命令经环境变量 `ASTER_JOB_INNER_B64`（UTF-8 base64）传入，再以 `-EncodedCommand` 交给内层 pwsh
 * ⇒ **零 argv 引号转义风险**（命令文本一个字节都不改）。
 */
export const JOB_LAUNCHER_PS1 = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$DllDir,
  [Parameter(Mandatory = $true)][string]$CsSourcePath,
  [int]$ProcessLimit = 64,
  [uint32]$UiFlags = 63,
  [string]$InnerExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
)

# windows-job 包装进程（ADR-031）：建作业 -> 把内层命令放进去跑 -> 透传退出码。
# Node 侧只传路径与参数；命令文本走 env ASTER_JOB_INNER_B64。
$ErrorActionPreference = "Stop"

$cs = [IO.File]::ReadAllText($CsSourcePath, [Text.Encoding]::UTF8)
$sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($cs))).Replace("-", "").Substring(0, 16).ToLower()
$dll = Join-Path $DllDir ("aster-job-" + $sha + ".dll")
try {
  if (Test-Path $dll) {
    [void][Reflection.Assembly]::LoadFrom($dll)   # 缓存命中：实测 ~13ms（现编 ~140ms）
  } else {
    Add-Type -TypeDefinition $cs -OutputAssembly $dll
    [void][Reflection.Assembly]::LoadFrom($dll)
  }
} catch {
  [Console]::Error.WriteLine("sandbox refused: cannot build the windows-job launcher -> " + $_.Exception.Message)
  exit 126
}

$inner = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ASTER_JOB_INNER_B64))
try {
  $job = [AsterJob]::CreateFencedJob([uint32]$ProcessLimit, [uint32]$UiFlags)
} catch {
  [Console]::Error.WriteLine("sandbox refused: cannot establish the windows-job fence -> " + $_.Exception.Message)
  exit 126
}
try {
  # 内层命令：同一份文本，一字不改；只在前面加一行压掉进度流（否则 CLIXML 进度会混进 stderr）。
  # 注意用**单引号**字面量：双引号里 PowerShell 会把 $ProgressPreference 当变量插值（实测踩过）。
  $script = '$ProgressPreference = ''SilentlyContinue''' + [char]10 + $inner
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $code = [AsterJob]::RunInJob($job, $InnerExe, "-NoProfile -NonInteractive -EncodedCommand $encoded")
  exit $code
} catch {
  [Console]::Error.WriteLine("sandbox refused: windows-job launcher failed -> " + $_.Exception.Message)
  exit 126
}
`;
