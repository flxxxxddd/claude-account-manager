/** A dependency-free arrow-key picker for choosing a profile. */
import { bar, c, formatReset, formatUtilization, limitColor, pad, symbols } from "../ui.ts";
import { bindingUtilization } from "../api.ts";
import type { ProfileStatus } from "../session.ts";

export interface PickerResult {
  name: string;
}

const ESC = "\x1b";

const KEY = {
  up: [`${ESC}[A`, "k"],
  down: [`${ESC}[B`, "\t", "j"],
  enter: ["\r", "\n"],
  cancel: [ESC, "\x03", "q"],
};

export async function pickProfile(
  statuses: ProfileStatus[],
  options: { title?: string } = {},
): Promise<PickerResult | null> {
  if (statuses.length === 0) return null;
  if (statuses.length === 1) return { name: statuses[0]!.name };

  const input = process.stdin;
  const output = process.stderr; // keep stdout clean for piping

  if (!input.isTTY) {
    // Non-interactive: fall back to the active profile, else the freshest one.
    const fallback = statuses.find((s) => s.active) ?? bestByLimit(statuses);
    return fallback ? { name: fallback.name } : null;
  }

  const title = options.title ?? "Select account";
  let index = Math.max(0, statuses.findIndex((s) => s.active));

  const nameWidth = Math.max(...statuses.map((s) => s.name.length));
  const emailWidth = Math.max(...statuses.map((s) => (s.profile.email ?? "—").length));

  const render = (first: boolean) => {
    if (!first) output.write(`${ESC}[${statuses.length + 2}A`);
    output.write(`${ESC}[J`);
    output.write(`${c.bold(title)} ${c.gray("↑↓ move · enter launch · esc cancel")}\n`);
    for (const [i, status] of statuses.entries()) {
      output.write(`${renderLine(status, i === index, nameWidth, emailWidth)}\n`);
    }
    output.write("\n");
  };

  const wasRaw = input.isRaw ?? false;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  output.write(`${ESC}[?25l`); // hide cursor
  render(true);

  try {
    return await new Promise<PickerResult | null>((resolve) => {
      const finish = (result: PickerResult | null) => {
        input.off("data", onData);
        resolve(result);
      };

      const onData = (chunk: string) => {
        if (KEY.cancel.includes(chunk)) return finish(null);
        if (KEY.up.includes(chunk)) {
          index = (index - 1 + statuses.length) % statuses.length;
          return render(false);
        }
        if (KEY.down.includes(chunk)) {
          index = (index + 1) % statuses.length;
          return render(false);
        }
        if (KEY.enter.includes(chunk)) return finish({ name: statuses[index]!.name });
        // Number shortcuts: 1..9 jump straight to a row.
        const digit = Number.parseInt(chunk, 10);
        if (!Number.isNaN(digit) && digit >= 1 && digit <= statuses.length) {
          index = digit - 1;
          return finish({ name: statuses[index]!.name });
        }
      };

      input.on("data", onData);
    });
  } finally {
    output.write(`${ESC}[?25h`); // show cursor
    input.setRawMode(wasRaw);
    input.pause();
  }
}

function renderLine(
  status: ProfileStatus,
  selected: boolean,
  nameWidth: number,
  emailWidth: number,
): string {
  const cursor = selected ? c.cyan("▸") : " ";
  const name = selected ? c.bold(status.name) : status.name;
  const email = c.gray(status.profile.email ?? "—");

  let limits: string;
  if (!status.loggedIn) {
    limits = c.red("needs login");
  } else if (status.usage?.five_hour) {
    const five = status.usage.five_hour;
    limits =
      `${bar(five.utilization, 10)} ${limitColor(five.utilization)(formatUtilization(five.utilization))} ` +
      c.gray(`↻${formatReset(five.resets_at)}`);
  } else {
    limits = c.gray("limits unknown");
  }

  const activeMark = status.active ? c.green(symbols.active) : " ";
  return `${cursor} ${activeMark} ${pad(name, nameWidth)}  ${pad(email, emailWidth)}  ${limits}`;
}

/** Lowest 5-hour utilisation wins; unknown usage sorts last. */
/**
 * The account with the most headroom, judged by whichever of its windows is
 * closest to full. An account idle for the hour but spent for the week is not
 * a good answer to "which one should I use".
 */
export function bestByLimit(statuses: ProfileStatus[]): ProfileStatus | undefined {
  const usable = statuses.filter((s) => s.loggedIn);
  if (usable.length === 0) return undefined;
  return usable.reduce((best, current) => {
    const a = bindingUtilization(best.usage) ?? Number.POSITIVE_INFINITY;
    const b = bindingUtilization(current.usage) ?? Number.POSITIVE_INFINITY;
    if (b !== a) return b < a ? current : best;
    // Same binding window: prefer the one with more of this hour left.
    const aFive = best.usage?.five_hour?.utilization ?? Number.POSITIVE_INFINITY;
    const bFive = current.usage?.five_hour?.utilization ?? Number.POSITIVE_INFINITY;
    return bFive < aFive ? current : best;
  });
}
