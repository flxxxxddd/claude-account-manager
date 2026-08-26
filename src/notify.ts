/**
 * Desktop notifications, using whatever the platform already ships.
 *
 * Nothing here is installed as a dependency: macOS has `osascript`, most Linux
 * desktops have `notify-send`, and Windows has PowerShell. A platform without
 * its tool simply gets no notification — a missed one is never worth an error.
 *
 * Text reaching these commands includes profile names and API messages, so no
 * variant interpolates into a shell. Arguments go through `execFile`, and the
 * two languages that still parse a string — AppleScript and PowerShell — read
 * their text from the environment or from an escaped literal, never from
 * concatenation.
 */
import { execFile } from "node:child_process";

export interface Notification {
  title: string;
  body: string;
}

const TIMEOUT_MS = 5_000;

/**
 * Escape a string for an AppleScript double-quoted literal.
 *
 * Only the backslash and the quote can end the literal, and the backslash has
 * to be doubled first or the escape it produces is itself escaped. Control
 * characters are flattened to spaces rather than escaped: a newline in a
 * notification body is not worth the risk of getting the quoting subtly wrong.
 */
export function appleScriptString(value: string): string {
  const flattened = value.replace(/[\x00-\x1f\x7f]/g, " ");
  return `"${flattened.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function run(command: string, args: string[], env?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: TIMEOUT_MS, env: env ? { ...process.env, ...env } : process.env },
      (err) => resolve(!err),
    );
  });
}

/** Show a notification. Returns whether the platform tool accepted it. */
export async function notify(
  notification: Notification,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const { title, body } = notification;

  if (platform === "darwin") {
    return run("osascript", [
      "-e",
      `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
    ]);
  }

  if (platform === "win32") {
    // The text is read from the environment so neither value is ever parsed as
    // PowerShell.
    const script = [
      "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')",
      "$icon = New-Object System.Windows.Forms.NotifyIcon",
      "$icon.Icon = [System.Drawing.SystemIcons]::Information",
      "$icon.BalloonTipTitle = $env:CCA_NOTIFY_TITLE",
      "$icon.BalloonTipText = $env:CCA_NOTIFY_BODY",
      "$icon.Visible = $true",
      "$icon.ShowBalloonTip(5000)",
      "Start-Sleep -Seconds 5",
      "$icon.Dispose()",
    ].join("; ");
    return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      CCA_NOTIFY_TITLE: title,
      CCA_NOTIFY_BODY: body,
    });
  }

  return run("notify-send", ["--app-name=cca", title, body]);
}
