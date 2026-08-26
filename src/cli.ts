#!/usr/bin/env node
/** cca — Claude Code account manager. */
import { loadConfig, type Config } from "./config.ts";
import { doctorCommand } from "./commands/doctor.ts";
import {
  installScheduler,
  schedulerStatus,
  tickCommand,
  uninstallScheduler,
} from "./commands/daemon.ts";
import { listCommand } from "./commands/list.ts";
import {
  importCommand,
  loginCommand,
  removeCommand,
  renameCommand,
  syncCommand,
  useCommand,
} from "./commands/profiles.ts";
import { runCommand, statusCommand } from "./commands/run.ts";
import { shellInitCommand } from "./commands/shell.ts";
import { notifyCommand } from "./commands/notify.ts";
import { refreshUsageCache, statuslineCommand } from "./commands/statusline.ts";
import { configureWarmup, refreshCommand, warmCommand } from "./commands/warm.ts";
import { c } from "./ui.ts";

const VERSION = "0.2.0";

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
  /** Everything after a bare `--`, forwarded to `claude`. */
  passthrough: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let passthrough: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (token.startsWith("--")) {
      const [name, inlineValue] = splitFlag(token.slice(2));
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
      } else if (VALUE_FLAGS.has(name) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) {
        flags.set(name, argv[++i]!);
      } else {
        flags.set(name, true);
      }
      continue;
    }
    positional.push(token);
  }

  return { command: positional[0] ?? "", positional: positional.slice(1), flags, passthrough };
}

const VALUE_FLAGS = new Set(["model", "at", "profiles", "poll", "interval", "mode", "name"]);

function splitFlag(token: string): [string, string | undefined] {
  const eq = token.indexOf("=");
  return eq === -1 ? [token, undefined] : [token.slice(0, eq), token.slice(eq + 1)];
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

function isolationFrom(args: Args): "shared" | "isolated" | undefined {
  if (flagBool(args, "isolated")) return "isolated";
  if (flagBool(args, "shared")) return "shared";
  const mode = flagString(args, "mode");
  if (mode === "isolated" || mode === "shared") return mode;
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (flagBool(args, "version") || args.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flagBool(args, "help") || args.command === "help") {
    printHelp();
    return 0;
  }

  const config: Config = await loadConfig();

  switch (args.command) {
    case "":
      // Bare `cca` is the everyday path: pick an account, launch Claude Code.
      return runCommand(config, { claudeArgs: args.passthrough });

    case "list":
    case "ls":
      return listCommand(config, {
        json: flagBool(args, "json"),
        noUsage: flagBool(args, "no-usage"),
      });

    case "status":
      return statusCommand(config, {
        json: flagBool(args, "json"),
        name: args.positional[0],
      });

    case "use":
      return requireArg(args, 0, "use <profile>", (name) => useCommand(config, name));

    case "run":
      return runCommand(config, {
        name: args.positional[0],
        last: flagBool(args, "last"),
        best: flagBool(args, "best"),
        claudeArgs: args.passthrough,
      });

    case "import":
      return importCommand(config, args.positional[0], { mode: isolationFrom(args) });

    case "login":
    case "add":
      return requireArg(args, 0, `${args.command} <profile>`, (name) =>
        loginCommand(config, name, { mode: isolationFrom(args) }),
      );

    case "remove":
    case "rm":
      return requireArg(args, 0, `${args.command} <profile>`, (name) =>
        removeCommand(config, name, { purge: flagBool(args, "purge") }),
      );

    case "rename": {
      const [from, to] = args.positional;
      if (!from || !to) {
        process.stderr.write(`Usage: ${c.bold("cca rename <old> <new>")}\n`);
        return 1;
      }
      return renameCommand(config, from, to);
    }

    case "sync":
      return requireArg(args, 0, "sync <profile>", (name) => syncCommand(config, name));

    case "warm":
      return warmCommand(config, {
        name: args.positional[0],
        all: flagBool(args, "all"),
        model: flagString(args, "model"),
        onlyIfCold: flagBool(args, "only-if-cold"),
        json: flagBool(args, "json"),
      });

    case "refresh":
      return refreshCommand(config, {
        name: args.positional[0],
        all: flagBool(args, "all"),
        force: flagBool(args, "force") || !flagBool(args, "if-needed"),
        json: flagBool(args, "json"),
      });

    case "warmup":
      return warmupCommand(config, args);

    case "daemon":
      return daemonCommand(config, args);

    case "notify": {
      const sub = args.positional[0] ?? "status";
      if (sub !== "on" && sub !== "off" && sub !== "test" && sub !== "status") {
        process.stderr.write(`Usage: ${c.bold("cca notify <on|off|test>")}\n`);
        return 1;
      }
      return notifyCommand(config, sub);
    }

    case "statusline":
      return statuslineCommand(config, { preview: flagBool(args, "preview") });

    case "cache-refresh": {
      // Internal: the detached child spawned by `cca statusline`.
      const name = args.positional[0];
      if (name) await refreshUsageCache(name);
      return 0;
    }

    case "shell-init":
      return shellInitCommand(args.positional[0]);

    case "doctor":
      return doctorCommand(config, { deep: flagBool(args, "deep") });

    default:
      process.stderr.write(`${c.red(`Unknown command: ${args.command}`)}\n\n`);
      printHelp();
      return 1;
  }
}

async function warmupCommand(config: Config, args: Args): Promise<number> {
  const sub = args.positional[0];
  const patch: Partial<Config["warmup"]> = {};

  switch (sub) {
    case "on":
      patch.enabled = true;
      break;
    case "off":
      patch.enabled = false;
      break;
    case "schedule":
      patch.enabled = true;
      patch.mode = "schedule";
      break;
    case "smart":
      patch.enabled = true;
      patch.mode = "smart";
      break;
    case undefined:
      return schedulerStatus();
    default:
      process.stderr.write(`Usage: ${c.bold("cca warmup <on|off|schedule|smart> [options]")}\n`);
      return 1;
  }

  const at = flagString(args, "at");
  if (at) patch.at = at.split(",").map((s) => s.trim()).filter(Boolean);

  const profiles = flagString(args, "profiles");
  if (profiles) patch.profiles = profiles.split(",").map((s) => s.trim()).filter(Boolean);

  const model = flagString(args, "model");
  if (model) patch.model = model;

  const poll = flagString(args, "poll");
  if (poll) patch.pollMinutes = Math.max(1, Number(poll) || config.warmup.pollMinutes);

  if (flagBool(args, "no-refresh")) patch.refreshTokens = false;
  if (flagBool(args, "refresh")) patch.refreshTokens = true;

  return configureWarmup(config, patch);
}

async function daemonCommand(config: Config, args: Args): Promise<number> {
  const sub = args.positional[0] ?? "status";
  switch (sub) {
    case "tick":
      return tickCommand(config, {
        dryRun: flagBool(args, "dry-run"),
        json: flagBool(args, "json"),
      });
    case "install": {
      const interval = Number(flagString(args, "interval") ?? config.warmup.pollMinutes);
      return installScheduler({
        binaryPath: process.execPath,
        intervalMinutes: Math.max(1, interval || 5),
      });
    }
    case "uninstall":
      return uninstallScheduler();
    case "status":
      return schedulerStatus();
    default:
      process.stderr.write(`Usage: ${c.bold("cca daemon <tick|install|uninstall|status>")}\n`);
      return 1;
  }
}

async function requireArg(
  args: Args,
  index: number,
  usage: string,
  fn: (value: string) => Promise<number>,
): Promise<number> {
  const value = args.positional[index];
  if (!value) {
    process.stderr.write(`Usage: ${c.bold(`cca ${usage}`)}\n`);
    return 1;
  }
  return fn(value);
}

function printHelp(): void {
  process.stdout.write(`${c.bold("cca")} — switch between Claude.ai accounts in Claude Code

${c.bold("Everyday")}
  cca                       pick an account and launch Claude Code
  cca -- --resume           same, forwarding arguments to claude
  cca run <name> -- <args>  launch a specific account
  cca run --last            reuse the last account, no picker
  cca run --best            use whichever account has the most quota left
  cca list                  accounts with live session limits
  cca status [name]         detail for one account
  cca use <name>            set the active account

${c.bold("Accounts")}
  cca import [name]         adopt the session you are already logged into
  cca login <name>          add an account (opens the Claude login)
  cca remove <name>         forget an account   ${c.gray("--purge also deletes its storage")}
  cca rename <old> <new>
  cca sync <name>           refresh cached email/organisation

${c.bold("Session warm-up")}
  cca warm [name|--all]     open the 5-hour window now
  cca refresh [name|--all]  rotate OAuth tokens so idle accounts stay valid
  cca warmup smart          warm each account as soon as its window resets
  cca warmup schedule --at 08:00,13:00
  cca warmup off
  cca daemon install        register the OS scheduler   ${c.gray("--interval <minutes>")}
  cca daemon uninstall | status | tick
  cca notify on|off|test    desktop alerts for warm-ups, limits and expiring logins

${c.bold("Integration")}
  cca shell-init fish       shell snippet so plain \`claude\` shows the picker
  cca statusline            the HUD for Claude Code's statusLine
  cca statusline --preview  redraw the last frame  ${c.gray("to try layout changes")}
  cca doctor [--deep]       verify the setup against Claude Code itself

${c.bold("Isolation")}
  ${c.gray("--shared    (default) only credentials differ; history, projects,")}
  ${c.gray("            settings, plugins and MCP servers stay in ~/.claude")}
  ${c.gray("--isolated  a fully separate Claude Code config directory")}
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${c.red("error")} ${message}\n`);
    process.exitCode = 1;
  });
