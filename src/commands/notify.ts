/** `cca notify` — turn desktop notifications on, off, or prove they work. */
import { saveConfig, type Config } from "../config.ts";
import { notify } from "../notify.ts";
import { c, symbols } from "../ui.ts";

export type NotifySub = "on" | "off" | "test" | "status";

export async function notifyCommand(config: Config, sub: NotifySub): Promise<number> {
  if (sub === "test") {
    const delivered = await notify({
      title: "cca",
      body: "Notifications are working. This is what an alert looks like.",
    });
    if (delivered) {
      process.stdout.write(`${c.green(symbols.ok)} Sent. If nothing appeared, check the notification permissions for your terminal.\n`);
      return 0;
    }
    process.stderr.write(
      `${c.red(symbols.fail)} The platform's notification tool did not accept it.\n` +
        `  ${c.gray(process.platform === "linux" ? "Install libnotify for `notify-send`." : "See `cca doctor`.")}\n`,
    );
    return 1;
  }

  if (sub === "on" || sub === "off") {
    config.notifications = { ...config.notifications, enabled: sub === "on" };
    await saveConfig(config);
  }

  const { enabled, onWarm, onLimit, onLoginExpiry, limitThreshold } = config.notifications;
  const kinds = [
    onWarm ? "window opened" : null,
    onLimit ? `account past ${limitThreshold}%` : null,
    onLoginExpiry ? "login expiring" : null,
  ].filter(Boolean);

  process.stdout.write(
    `${enabled ? c.green(symbols.active) : c.gray(symbols.inactive)} Notifications ${enabled ? "on" : "off"}\n` +
      `  ${c.gray(kinds.length ? kinds.join(" · ") : "nothing selected")}\n` +
      (enabled
        ? `  ${c.gray("Delivered by `cca daemon tick`, so they need the scheduler installed.")}\n`
        : ""),
  );
  return 0;
}
