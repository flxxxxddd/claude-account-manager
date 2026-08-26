/** `cca shell-init <shell>` — prints the snippet that makes `claude` pick an account. */
import { basename } from "node:path";
import { c } from "../ui.ts";

export type ShellName = "fish" | "zsh" | "bash" | "pwsh";

const SNIPPETS: Record<ShellName, string> = {
  fish: `# claude-account-manager
function claude --description 'Claude Code with account picker'
    command cca run -- $argv
end

# Skip the picker and reuse the last account:
#   alias cl 'command cca run --last --'
`,
  zsh: `# claude-account-manager
claude() {
  command cca run -- "$@"
}

# Skip the picker and reuse the last account:
#   alias cl='command cca run --last --'
`,
  bash: `# claude-account-manager
claude() {
  command cca run -- "$@"
}

# Skip the picker and reuse the last account:
#   alias cl='command cca run --last --'
`,
  pwsh: `# claude-account-manager
function claude {
  cca run -- @args
}

# Skip the picker and reuse the last account:
#   function cl { cca run --last -- @args }
`,
};

const RC_HINT: Record<ShellName, string> = {
  fish: "~/.config/fish/config.fish",
  zsh: "~/.zshrc",
  bash: "~/.bashrc",
  pwsh: "$PROFILE",
};

export function shellInitCommand(shell?: string): number {
  const resolved = normalizeShell(shell);
  if (!resolved) {
    process.stderr.write(
      `${c.red("Unknown shell.")} Supported: fish, zsh, bash, pwsh\n` +
        `Usage: ${c.bold("cca shell-init fish")}\n`,
    );
    return 1;
  }

  process.stdout.write(SNIPPETS[resolved]);

  if (process.stdout.isTTY) {
    process.stderr.write(
      `\n${c.gray(`Add it permanently with:  cca shell-init ${resolved} >> ${RC_HINT[resolved]}`)}\n`,
    );
  }
  return 0;
}

function normalizeShell(shell: string | undefined): ShellName | null {
  const candidate = (shell ?? detectShell() ?? "").toLowerCase();
  if (candidate.includes("fish")) return "fish";
  if (candidate.includes("zsh")) return "zsh";
  if (candidate.includes("bash")) return "bash";
  if (candidate.includes("pwsh") || candidate.includes("powershell")) return "pwsh";
  return null;
}

function detectShell(): string | undefined {
  const shell = process.env.SHELL;
  return shell ? basename(shell) : undefined;
}
