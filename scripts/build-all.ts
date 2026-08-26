/**
 * Build every shipped artifact.
 *
 * The npm package carries a Node-targeted bundle so a single publish works on
 * every platform; the release page carries Bun-compiled binaries so people can
 * install without a JavaScript runtime at all.
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { $ } from "bun";

const TARGETS = [
  { target: "bun-darwin-arm64", name: "cca-macos-arm64" },
  { target: "bun-darwin-x64", name: "cca-macos-x64" },
  { target: "bun-linux-x64", name: "cca-linux-x64" },
  { target: "bun-linux-arm64", name: "cca-linux-arm64" },
  { target: "bun-windows-x64", name: "cca-windows-x64.exe" },
] as const;

await rm("dist", { recursive: true, force: true });
await mkdir("dist/bin", { recursive: true });

console.log("→ node bundle (npm package)");
await $`bun build src/cli.ts --target=node --outfile dist/cli.js`;
await chmod("dist/cli.js", 0o755);

for (const { target, name } of TARGETS) {
  console.log(`→ ${name}`);
  await $`bun build src/cli.ts --compile --target=${target} --outfile dist/bin/${name}`;
}

console.log("done");
