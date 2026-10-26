<#
.SYNOPSIS
  自动点掉 DSH 重启时弹出的原生恢复对话框：**直接向按钮子窗口投递消息**（BM_CLICK），
  不依赖焦点、不依赖前台、也不假设按钮的控件 ID。

.DESCRIPTION
  为什么改成「直接投递消息」：
    前几轮都栽在同一个前提上 —— 以为键盘/前台能可靠地把点击送进去。实际上：
      1. Electron 的 `dialog.showMessageBox` 在 Windows 上走的是 **TaskDialog**。TaskDialog 的按钮
         **不保证**是 IDOK(1) / IDCANCEL(2) 这些经典对话框 ID，`WM_COMMAND(1)` 很可能什么都没打到。
      2. `WM_KEYDOWN(VK_RETURN)` 只有目标窗口有键盘焦点时才起作用 —— TaskDialog 是模态的，焦点
         通常在它自己的子控件上，而本脚本是 detached 后台进程，本来就没资格抢。
      3. `SendKeys` 更是把键发给「当前前台窗口」，前台没抢到就等于把回车送给别的程序。
    而 **`BM_CLICK` 是按钮自己处理的消息**：把消息投递给按钮 hwnd，按钮就执行和真实点击一样的动作，
    完全不需要它是前台、不需要它有焦点。所以这条路才是主路径。

  为什么按钮要「递归」找：
    TaskDialog 的按钮嵌在内部容器（甚至子对话框）里，只查对话框的直接子窗口可能一个都看不到。这里用
    `GetWindow(GW_CHILD / GW_HWNDNEXT)` 递归遍历整棵子树（再用 `EnumChildWindows` 补一遍漏项），
    把每个 Button 的 hwnd / class / 文案 / 控件 ID 都写进日志。

  四级兜底（每一级之后都检查对话框是否消失）：
    1. PostMessage(btn, BM_CLICK)                       —— 主路径，异步入队，不需要焦点
    2. SendMessage(btn, BM_CLICK)                       —— 同步版，补「消息被丢弃 / 处理线程忙」
    3. PostMessage(btn, WM_LBUTTONDOWN + WM_LBUTTONUP)  —— 只认鼠标消息的按钮靠这条
    4. SendMessage(dialog, WM_COMMAND, MAKEWPARAM(GetDlgCtrlID(btn), BN_CLICKED), btn)
                                                         —— 往父对话框投通知，控件 ID 现取，绝不猜 IDOK
    四级都不成，日志能直接区分是「对话框没找到」「按钮没找到」还是「消息没被处理」。

  为什么还保留「手段 1：ALT trick + 置顶」：
    它**只为让人看得见**这个对话框（以及确保它不被别的窗口压住），不再是点击成功的前提；失败也不阻断
    BM_CLICK 路径。原理：Windows 有前台锁，`SetForegroundWindow` 只在「调用线程属于前台进程」或
    「该进程最近收到过用户输入」时才生效，否则静默忽略。所以先 keybd_event 注入一次 ALT 按下/抬起取得
    资格，再 ShowWindow(SW_RESTORE) → SetWindowPos(HWND_TOPMOST) → BringWindowToTop → SetForegroundWindow。

  安全边界：
    1. 对话框标题必须包含「无法使用」/ "is unavailable"，且不含 欢迎/Welcome 之类的干扰词。
    2. 只点**文案精确等于**「重启」/「Restart」的按钮；含「退出 / Exit / 禁用 / Disable」的按钮绝不碰
       —— 那个按钮会禁用第三方插件（也就是本插件本身），误点是灾难性的。
    3. 本脚本从不对任意窗口发键盘输入：没有 SendKeys，也没有把 WM_KEYDOWN 送给非按钮目标。
    4. -DryRun 只枚举并记录，不发任何消息。

  独立性：由 Host 以 detached/stdio-ignore 方式启动，不依赖 Host 存活。日志追加到
  <DSH home>/remote-control/relaunch.log（UTC 时间戳 + phase 标记），和 relaunch.mjs 共用同一条时间线。
  只用系统自带组件（Windows PowerShell 5.1 + user32/kernel32），不装依赖。

.PARAMETER TargetPid
  主窗口所属进程：Host 传进来的 process.pid（桌面形态下窗口也可能属于外壳进程，用 FallbackPid 兜底）。
.PARAMETER FallbackPid
  主窗口 pid 的兜底（通常是 Host 的 process.ppid）。
.PARAMETER WindowTitle
  主窗口标题关键词：多个候选窗口里优先挑它，其余按面积最大取。
.PARAMETER DialogTitle
  对话框标题关键词，逗号分隔可给多个（中文「无法使用」/ 英文 "is unavailable"），任一命中即可。
.PARAMETER TimeoutMs
  总超时（毫秒），超时即安静退出。
.PARAMETER DialogWaitMs
  等对话框出现的窗口（毫秒，默认 30s）：等不到就干净退出，不空转。
.PARAMETER ReadyPath
  ready 标记文件路径。Host 每 100ms 轮询它，见到该文件才允许发 fatal —— 否则 shell 一旦退出会把
  刚启动的本进程一起拆掉。脚本在动态类型加载成功后**立刻**写它。
.PARAMETER IntervalMs
  两轮尝试之间的间隔（也用于等对话框出现）。
.PARAMETER LogPath
  追加日志文件；默认 <DSH home>/remote-control/relaunch.log。
.PARAMETER DryRun
  只枚举/记录，不发消息。
.PARAMETER SelfTest
  只做类型加载与参数校验，不碰任何窗口。
#>
[CmdletBinding()]
param(
  [int]$TargetPid = 0,
  [int]$FallbackPid = 0,
  [string]$WindowTitle = 'DeepSeek Harness',
  [string]$DialogTitle = '无法使用,is unavailable',
  [int]$TimeoutMs = 60000,
  [int]$DialogWaitMs = 30000,
  [string]$ReadyPath = '',
  [int]$IntervalMs = 400,
  [string]$LogPath = '',
  [switch]$DryRun,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# 总尝试次数，以及每次「点一下再看结果」的等待时间。
$MaxAttempts = 8
$VerifyDelayMs = 600

# ---------------------------------------------------------------- 日志

function Resolve-LogPath {
  if ($LogPath -ne '') { return $LogPath }
  $base = $env:DSH_HOME
  if ([string]::IsNullOrWhiteSpace($base)) { $base = Join-Path $HOME '.dsh' }
  return (Join-Path $base 'remote-control\relaunch.log')
}

<#
  写一行日志：`[UTC 时间] confirm-restart: [phase=xxx] 内容`。
  phase 是排障索引：start / init / selftest / phase1 / find-dialog / enum-buttons / alt-trick /
  click / verify / done / gave-up。失败时据此一眼看出断在「没找到对话框」「没找到按钮」还是
  「消息没被处理」。日志写不进去也绝不影响主流程。
#>
function Write-Trace([string]$Phase, [string]$Message) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $line = "[$stamp] confirm-restart: [phase=$Phase] $Message"
  try {
    $path = Resolve-LogPath
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $path -Value $line -Encoding UTF8
  } catch {
    # 忽略：日志不是功能本身。
  }
}

# ---------------------------------------------------------------- Win32（内联 P/Invoke，只 Add-Type 一次）

<#
  所有 Win32 调用都写在 C# 里：PowerShell 把脚本块转成 EnumWindows 委托时作用域容易出意外，C# 里直接
  写更稳；同时只编译一次并缓存类型，避免在 PS 里反复 Add-Type 造成重载解析歧义。
  目标语言版本是 Windows PowerShell 5.1 自带的 C# 5：不用 out var、不用局部函数、不用字符串插值。
#>
$nativeSource = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshWindow
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    // keybd_event 的参数必须写成 byte：写成 int 时重载解析会挑不到正确签名。
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetDlgCtrlID(IntPtr hWnd);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    public const int SW_RESTORE = 9;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint GA_ROOT = 2;
    public const uint GW_CHILD = 5;
    public const uint GW_HWNDNEXT = 2;
    public const byte VK_MENU = 0x12;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint BM_CLICK = 0x00F5;
    public const uint WM_COMMAND = 0x0111;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    /// <summary>窗口标题（空窗口返回空串）。</summary>
    public static string TitleOf(IntPtr hWnd)
    {
        int length = GetWindowTextLength(hWnd);
        if (length <= 0) return string.Empty;
        var builder = new StringBuilder(length + 1);
        GetWindowText(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }

    /// <summary>窗口类名；Button 控件就是靠它认出来的。</summary>
    public static string ClassOf(IntPtr hWnd)
    {
        var builder = new StringBuilder(256);
        GetClassName(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }

    /// <summary>最小化窗口的 (-32000,...) 坐标按 0 处理，避免选出「假的大窗口」。</summary>
    public static long AreaOf(IntPtr hWnd)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) return 0;
        long width = rect.Right - rect.Left;
        long height = rect.Bottom - rect.Top;
        if (width < 0) width = 0;
        if (height < 0) height = 0;
        return width * height;
    }

    /// <summary>
    /// 按 pid 找主窗口：同一进程、可见、标题非空、标题不含对话框标记；多个候选里标题带关键词的优先，
    /// 其余取面积最大的那个。
    /// </summary>
    public static IntPtr FindMainWindow(uint pid, string titleKeyword, string dialogMarker)
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = -1;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner != pid) return true;
            if (!IsWindowVisible(hWnd)) return true;
            string title = TitleOf(hWnd);
            if (title.Length == 0) return true;
            if (dialogMarker.Length > 0 && title.IndexOf(dialogMarker, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            long score = AreaOf(hWnd);
            if (titleKeyword.Length > 0 && title.IndexOf(titleKeyword, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                score += 1000000000L;
            }
            if (score > bestScore)
            {
                bestScore = score;
                best = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    /// <summary>找标题包含 marker 的可见顶层窗口（恢复对话框就是 shell 的顶层 owned 窗口）。</summary>
    public static IntPtr FindDialog(string marker, string[] exclude)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            string title = TitleOf(hWnd);
            if (title.Length == 0) return true;
            if (title.IndexOf(marker, StringComparison.OrdinalIgnoreCase) < 0) return true;
            if (exclude != null)
            {
                foreach (string word in exclude)
                {
                    if (!string.IsNullOrEmpty(word) && title.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
            }
            found = hWnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>前台窗口（或其根窗口）是否就是 hWnd。</summary>
    public static bool IsForeground(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return false;
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        if (foreground == hWnd) return true;
        if (GetAncestor(foreground, GA_ROOT) == hWnd) return true;
        if (GetAncestor(hWnd, GA_ROOT) == foreground) return true;
        return false;
    }

    /// <summary>@returns 前台窗口的 16 进制句柄（日志里对照每次尝试）。</summary>
    public static string ForegroundHex()
    {
        return "0x" + GetForegroundWindow().ToInt64().ToString("X8");
    }

    /// <summary>
    /// 手段 1：ALT trick + 置顶 + 抢前台。只为「让人看得见对话框」，不参与点击是否成功的判断。
    /// 前台锁：SetForegroundWindow 只在调用方最近收到过用户输入时生效，所以先 keybd_event 注入 ALT。
    /// </summary>
    public static bool ForceFocus(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return false;

        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

        ShowWindow(hWnd, SW_RESTORE);
        SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);

        if (!IsForeground(hWnd))
        {
            IntPtr foreground = GetForegroundWindow();
            uint foregroundThread = 0;
            if (foreground != IntPtr.Zero)
            {
                uint ignored;
                foregroundThread = GetWindowThreadProcessId(foreground, out ignored);
            }
            uint selfThread = GetCurrentThreadId();
            if (foregroundThread != 0 && foregroundThread != selfThread && AttachThreadInput(selfThread, foregroundThread, true))
            {
                try
                {
                    BringWindowToTop(hWnd);
                    SetForegroundWindow(hWnd);
                }
                finally
                {
                    AttachThreadInput(selfThread, foregroundThread, false);
                }
            }

            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            SetForegroundWindow(hWnd);
        }

        return IsForeground(hWnd);
    }

    /// <summary>
    /// 递归收集子树里的 Button（深度上限 12，防止异常窗口图出现环）。TaskDialog 的按钮可能嵌在子对话框
    /// 里，只查一层会一个都找不到，所以这里是真正的递归。
    /// </summary>
    private static void CollectButtons(IntPtr parent, int depth, List<IntPtr> found)
    {
        IntPtr child = GetWindow(parent, GW_CHILD);
        while (child != IntPtr.Zero)
        {
            if (IsWindowVisible(child) && string.Equals(ClassOf(child), "Button", StringComparison.OrdinalIgnoreCase))
            {
                found.Add(child);
            }
            if (depth < 12)
            {
                CollectButtons(child, depth + 1, found);
            }
            child = GetWindow(child, GW_HWNDNEXT);
        }
    }

    /// <summary>递归收集 + EnumChildWindows 补漏，返回去重后的按钮句柄。</summary>
    public static IntPtr[] ButtonsOf(IntPtr dialog)
    {
        var found = new List<IntPtr>();
        CollectButtons(dialog, 0, found);
        EnumChildWindows(dialog, delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (IsWindowVisible(hWnd) && string.Equals(ClassOf(hWnd), "Button", StringComparison.OrdinalIgnoreCase) && !found.Contains(hWnd))
            {
                found.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    /// <summary>@returns 每个按钮一行描述：hwnd / class / 文案 / ctrlId，供日志逐行写入。</summary>
    public static string[] DescribeButtons(IntPtr dialog)
    {
        IntPtr[] buttons = ButtonsOf(dialog);
        var lines = new List<string>();
        for (int index = 0; index < buttons.Length; index++)
        {
            IntPtr button = buttons[index];
            lines.Add("hwnd=0x" + button.ToInt64().ToString("X8")
                + " class=" + ClassOf(button)
                + " text=" + TitleOf(button)
                + " ctrlId=" + GetDlgCtrlID(button).ToString());
        }
        return lines.ToArray();
    }

    /// <summary>
    /// 找文案**精确等于** allow 里某一项、且不含 deny 里任何词的按钮。
    /// 「禁用第三方插件、备份 profile patch 并重启」含「禁用」，因此永远不会被返回。
    /// </summary>
    public static IntPtr FindButton(IntPtr dialog, string[] allow, string[] deny)
    {
        IntPtr[] buttons = ButtonsOf(dialog);
        for (int index = 0; index < buttons.Length; index++)
        {
            string label = TitleOf(buttons[index]).Trim();
            if (label.Length == 0) continue;
            bool denied = false;
            if (deny != null)
            {
                foreach (string word in deny)
                {
                    if (!string.IsNullOrEmpty(word) && label.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        denied = true;
                        break;
                    }
                }
            }
            if (denied) continue;
            if (allow != null)
            {
                foreach (string word in allow)
                {
                    if (word.Length > 0 && string.Equals(label, word, StringComparison.OrdinalIgnoreCase))
                    {
                        return buttons[index];
                    }
                }
            }
        }
        return IntPtr.Zero;
    }

    /// <summary>兜底 1（主路径）：PostMessage(BM_CLICK)。异步入队，不要求焦点。</summary>
    public static bool PostClick(IntPtr button)
    {
        if (button == IntPtr.Zero || !IsWindow(button)) return false;
        return PostMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    /// <summary>兜底 2：SendMessage(BM_CLICK)。同步等处理线程，返回值是按钮过程的结果。</summary>
    public static IntPtr SendClick(IntPtr button)
    {
        if (button == IntPtr.Zero || !IsWindow(button)) return new IntPtr(-1);
        return SendMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    /// <summary>兜底 3：PostMessage(WM_LBUTTONDOWN) + WM_LBUTTONUP。只认鼠标消息的按钮靠这条。</summary>
    public static bool PostMouseClick(IntPtr button)
    {
        if (button == IntPtr.Zero || !IsWindow(button)) return false;
        bool down = PostMessage(button, WM_LBUTTONDOWN, IntPtr.Zero, IntPtr.Zero);
        bool up = PostMessage(button, WM_LBUTTONUP, IntPtr.Zero, IntPtr.Zero);
        return down && up;
    }

    /// <summary>
    /// 兜底 4：向父对话框发送 WM_COMMAND(MAKEWPARAM(ctrlId, BN_CLICKED), btnHwnd)。
    /// BN_CLICKED = 0，所以 wParam 的低 16 位就是控件 ID —— 用 GetDlgCtrlID 现取，绝不猜 IDOK。
    /// </summary>
    public static IntPtr SendCommand(IntPtr dialog, IntPtr button)
    {
        if (dialog == IntPtr.Zero || !IsWindow(dialog) || button == IntPtr.Zero) return new IntPtr(-1);
        int controlId = GetDlgCtrlID(button) & 0xFFFF;
        return SendMessage(dialog, WM_COMMAND, new IntPtr(controlId), button);
    }
}
'@

$script:NativeReady = $false
function Initialize-Native {
  # 只编译一次：同一进程里重复 Add-Type 同一类型会报「类型已存在」，先探测再加载。
  if (-not ('DshWindow' -as [type])) {
    Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
  }
  $script:NativeReady = $true
}

<#
  写 ready 标记：Host 见到这个文件才放行 fatal。
  为什么用 WriteAllText 而不是 Add-Content：前者一次写入立即落盘，后者可能按行缓冲；Host 每 100ms
  轮询一次，早 50ms 被看到就意味着早 50ms 放行，直接影响它能不能活过 shell 的退出。
  @returns 是否写成功（失败时 Host 会判定助手没起来并取消重启，这是安全的失败方向）。
#>
function Write-ReadyFlag([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  try {
    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, "pid=$PID`nreadyAt=$((Get-Date).ToUniversalTime().ToString('o'))`n")
    return $true
  } catch {
    return $false
  }
}

# 对话框标题标记（逗号分隔，任一命中即算）。
$markers = @($DialogTitle -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($markers.Count -eq 0) { $markers = @('无法使用') }
# 干扰词：标题里带这些的窗口不是恢复对话框。
$titleExclude = @('欢迎', 'Welcome')
# 主窗口候选里要排除的对话框标记。
$mainExcludeMarker = $markers[0]
# 按钮白名单 / 黑名单：白名单是**精确等于**，黑名单是包含即拒绝。
$buttonAllow = @('重启', 'Restart')
$buttonDeny = @('退出', 'Exit', '禁用', 'Disable', 'Quit')

# ---------------------------------------------------------------- 小工具

function Format-Hwnd([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { return '0x00000000' }
  return ('0x{0:X8}' -f $Handle.ToInt64())
}

<# @returns 标题是否像那个恢复对话框。 #>
function Test-DialogTitle([string]$Title) {
  if ([string]::IsNullOrWhiteSpace($Title)) { return $false }
  foreach ($word in $titleExclude) {
    if ($Title.IndexOf($word, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $false }
  }
  foreach ($marker in $markers) {
    if ($Title.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}

<# @returns 对话框是否仍然存在（先看原句柄，再按标题重新找一遍，防止它换了新句柄）。 #>
function Test-DialogPresent([IntPtr]$Dialog) {
  if ($Dialog -ne [IntPtr]::Zero -and [DshWindow]::IsWindow($Dialog) -and [DshWindow]::IsWindowVisible($Dialog) -and (Test-DialogTitle ([DshWindow]::TitleOf($Dialog)))) {
    return $true
  }
  foreach ($marker in $markers) {
    if ([DshWindow]::FindDialog($marker, $titleExclude) -ne [IntPtr]::Zero) { return $true }
  }
  return $false
}

<# 按标题标记找对话框；返回第一个命中的可见顶层窗口。 #>
function Find-DialogWindow {
  foreach ($marker in $markers) {
    $window = [DshWindow]::FindDialog($marker, $titleExclude)
    if ($window -ne [IntPtr]::Zero) { return $window }
  }
  return [IntPtr]::Zero
}

<# 尝试找主窗口：先 TargetPid（Host 自己），再 FallbackPid（桌面外壳）。 #>
function Find-MainWindow {
  $candidates = @()
  if ($TargetPid -gt 0) { $candidates += [uint32]$TargetPid }
  if ($FallbackPid -gt 0 -and $FallbackPid -ne $TargetPid) { $candidates += [uint32]$FallbackPid }
  foreach ($candidate in $candidates) {
    $window = [DshWindow]::FindMainWindow($candidate, $WindowTitle, $mainExcludeMarker)
    if ($window -ne [IntPtr]::Zero) {
      $titleText = [DshWindow]::TitleOf($window)
      Write-Trace 'phase1' "main window: pid=$candidate hwnd=$(Format-Hwnd $window) title=$titleText"
      return $window
    }
    Write-Trace 'phase1' "no visible titled window for pid=$candidate"
  }
  return [IntPtr]::Zero
}

# ---------------------------------------------------------------- 主流程

Write-Trace 'start' "pid=$PID targetPid=$TargetPid fallbackPid=$FallbackPid windowTitle=$WindowTitle dialogTitle=$DialogTitle timeout=${TimeoutMs}ms dialogWait=${DialogWaitMs}ms interval=${IntervalMs}ms attempts=$MaxAttempts ready=$ReadyPath dryRun=$($DryRun.IsPresent)"

try {
  Initialize-Native
} catch {
  # Add-Type 失败必须写清楚：后面所有 P/Invoke 都用不了，脚本只能退出。
  Write-Trace 'init' "Add-Type failed: $($_.Exception.Message)"
  exit 2
}

if ($SelfTest) {
  Write-Trace 'selftest' 'native types loaded; parameters accepted'
  exit 0
}

# ---------------- ready 握手：Host 见到这个文件才发 fatal ----------------
# 顺序刻意放在类型加载成功之后、碰任何窗口之前：此时脚本已经能干活，而 Host 一旦确认就会弹对话框。
# 写失败（路径不可写等）直接退出，让 Host 超时取消重启 —— 绝不留下一个没人点的模态框。
if (-not [string]::IsNullOrWhiteSpace($ReadyPath)) {
  $readyWritten = Write-ReadyFlag $ReadyPath
  Write-Trace 'ready' "ready flag written=$readyWritten path=$ReadyPath"
  if (-not $readyWritten) { exit 3 }
}

# ---------------- 阶段一（只为看得见）：把主窗口顶到前台 ----------------
# 它不是点击成功的前提：实在抢不到前台也不影响后面的 BM_CLICK 路径。
$mainWindow = [IntPtr]::Zero
try {
  $mainWindow = Find-MainWindow
} catch {
  Write-Trace 'phase1' "main window lookup failed: $($_.Exception.Message)"
}
if ($mainWindow -ne [IntPtr]::Zero) {
  try {
    $focused = [DshWindow]::ForceFocus($mainWindow)
    Write-Trace 'alt-trick' "main window=$(Format-Hwnd $mainWindow) foreground=$([DshWindow]::ForegroundHex()) focused=$focused"
  } catch {
    Write-Trace 'alt-trick' "ForceFocus threw: $($_.Exception.Message)"
  }
}

# ---------------- 阶段二：等对话框 → 递归找按钮 → 四级消息兜底 ----------------
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$dialogWait = if ($DialogWaitMs -gt 0) { $DialogWaitMs } else { 30000 }
# 等对话框有单独的窗口（默认 30s）：Host 只是请 shell 弹框，等不到就说明这次重启没发生，
# 没必要空转到总超时 —— 干净退出，日志里留一句即可。
$dialogDeadline = (Get-Date).AddMilliseconds($dialogWait)
$attempts = 0
$dialogLogged = [IntPtr]::Zero
$waitingLogged = $false
Write-Trace 'find-dialog' "waiting for the recovery dialog (dialogWait=${dialogWait}ms timeout=${TimeoutMs}ms interval=${IntervalMs}ms markers=$($markers -join '|'))"

while ((Get-Date) -lt $deadline -and (Get-Date) -lt $dialogDeadline -and $attempts -lt $MaxAttempts) {
  $dialog = [IntPtr]::Zero
  try {
    $dialog = Find-DialogWindow
  } catch {
    Write-Trace 'find-dialog' "dialog lookup failed: $($_.Exception.Message)"
  }

  if ($dialog -eq [IntPtr]::Zero) {
    # 还没出现（或已经消失）：等下一轮，什么都不做。
    if (-not $waitingLogged) {
      $waitingLogged = $true
      Write-Trace 'find-dialog' 'no matching dialog yet; waiting (only waiting, nothing is pressed)'
    }
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }

  $attempts += 1
  if ($dialog -ne $dialogLogged) {
    $dialogLogged = $dialog
    $dialogTitle = [DshWindow]::TitleOf($dialog)
    Write-Trace 'find-dialog' "dialog=$(Format-Hwnd $dialog) title=$dialogTitle foreground=$([DshWindow]::ForegroundHex())"
  }

  # 只为看得见：对对话框再做一次 ALT trick（失败不阻断）。
  try {
    $focused = [DshWindow]::ForceFocus($dialog)
    Write-Trace 'alt-trick' "dialog=$(Format-Hwnd $dialog) attempt=$attempts foreground=$([DshWindow]::ForegroundHex()) focused=$focused"
  } catch {
    Write-Trace 'alt-trick' "ForceFocus threw on the dialog: $($_.Exception.Message)"
  }

  # 诊断核心：把枚举到的每个按钮逐行记下来。失败时一眼看出「没找到按钮」还是「消息没被处理」。
  $buttonLines = @()
  try {
    $buttonLines = [DshWindow]::DescribeButtons($dialog)
  } catch {
    Write-Trace 'enum-buttons' "enumeration failed: $($_.Exception.Message)"
  }
  if ($buttonLines.Count -eq 0) {
    Write-Trace 'enum-buttons' "dialog=$(Format-Hwnd $dialog) buttons=0 (no Button child found yet)"
  } else {
    $index = 0
    foreach ($line in $buttonLines) {
      Write-Trace 'enum-buttons' "dialog=$(Format-Hwnd $dialog) button[$index]=$line"
      $index += 1
    }
  }

  if ($DryRun.IsPresent) {
    Write-Trace 'done' 'dry-run: enumeration complete, no message posted'
    exit 0
  }

  # 只认文案精确等于「重启」/「Restart」的按钮；含 退出/禁用/Disable 的按钮不会被返回。
  $button = [IntPtr]::Zero
  try {
    $button = [DshWindow]::FindButton($dialog, $buttonAllow, $buttonDeny)
  } catch {
    Write-Trace 'enum-buttons' "button matching failed: $($_.Exception.Message)"
  }
  if ($button -eq [IntPtr]::Zero) {
    Write-Trace 'enum-buttons' 'no button whose label is exactly 「重启」/「Restart」 yet; waiting for the dialog to finish building'
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }

  $buttonHex = Format-Hwnd $button
  $controlId = [DshWindow]::GetDlgCtrlID($button)
  Write-Trace 'click' "selected button=$buttonHex ctrlId=$controlId attempt=$attempts"

  # 兜底 1（主路径）：PostMessage(BM_CLICK) —— 按钮自己处理，不需要焦点。
  $postResult = [DshWindow]::PostClick($button)
  Write-Trace 'click' "method=BM_CLICK(post) target=$buttonHex result=$postResult"
  Start-Sleep -Milliseconds $VerifyDelayMs
  if (-not (Test-DialogPresent $dialog)) {
    Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) gone after BM_CLICK(post); restart accepted"
    Write-Trace 'done' "attempt=$attempts method=BM_CLICK(post)"
    exit 0
  }
  Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) still present after BM_CLICK(post)"

  # 兜底 2：SendMessage(BM_CLICK) —— 同步版，补「消息被丢弃 / 处理线程忙」。
  $sendResult = [DshWindow]::SendClick($button)
  Write-Trace 'click' "method=BM_CLICK(send) target=$buttonHex result=$sendResult"
  Start-Sleep -Milliseconds $VerifyDelayMs
  if (-not (Test-DialogPresent $dialog)) {
    Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) gone after BM_CLICK(send); restart accepted"
    Write-Trace 'done' "attempt=$attempts method=BM_CLICK(send)"
    exit 0
  }
  Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) still present after BM_CLICK(send)"

  # 兜底 3：鼠标按下/抬起消息 —— 只认鼠标消息的按钮靠这条。
  $mouseResult = [DshWindow]::PostMouseClick($button)
  Write-Trace 'click' "method=WM_LBUTTONDOWN+WM_LBUTTONUP target=$buttonHex result=$mouseResult"
  Start-Sleep -Milliseconds $VerifyDelayMs
  if (-not (Test-DialogPresent $dialog)) {
    Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) gone after mouse messages; restart accepted"
    Write-Trace 'done' "attempt=$attempts method=WM_LBUTTONDOWN+WM_LBUTTONUP"
    exit 0
  }
  Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) still present after mouse messages"

  # 兜底 4：向父对话框发 WM_COMMAND(ctrlId, BN_CLICKED, btn) —— 控件 ID 现取，不假设 IDOK。
  $commandResult = [DshWindow]::SendCommand($dialog, $button)
  Write-Trace 'click' "method=WM_COMMAND(ctrlId=$controlId, BN_CLICKED) target=$(Format-Hwnd $dialog) result=$commandResult"
  Start-Sleep -Milliseconds $VerifyDelayMs
  if (-not (Test-DialogPresent $dialog)) {
    Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) gone after WM_COMMAND; restart accepted"
    Write-Trace 'done' "attempt=$attempts method=WM_COMMAND"
    exit 0
  }
  Write-Trace 'verify' "dialog=$(Format-Hwnd $dialog) still present after WM_COMMAND"

  Start-Sleep -Milliseconds $IntervalMs
}

if ($attempts -eq 0) {
  # 一条按钮尝试都没发生：这段等待里根本没有出现匹配的对话框（Host 请求被取消 / shell 没弹框）。
  # 这不是失败处理，干净退出即可 —— 绝不空转到总超时。
  Write-Trace 'done' "no recovery dialog within ${dialogWait}ms; exiting cleanly without pressing anything"
  exit 0
}

Write-Trace 'gave-up' "attempts=$attempts; no method dismissed the dialog. Nothing else was pressed (退出/禁用 were never candidates)."
exit 1
