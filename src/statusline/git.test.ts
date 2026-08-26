import { describe, expect, test } from "bun:test";
import { parseStatus } from "./git.ts";

/**
 * `--porcelain=v2` is a stable, documented format, which is exactly why the
 * status line depends on it — but only if the entry prefixes are read right.
 * `2 ` (rename) counts as a change; `# ` lines never do.
 */
describe("parseStatus", () => {
  test("counts each entry kind separately", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/ui.ts",
      "1 M. N... 100644 100644 100644 ccc ddd src/cli.ts",
      "2 R. N... 100644 100644 100644 eee fff R100 new.ts\told.ts",
      "u UU N... 100644 100644 100644 100644 ggg hhh iii conflict.ts",
      "? scratch.md",
      "? notes.txt",
      "",
    ].join("\n");

    expect(parseStatus(output)).toEqual({
      modified: 3,
      untracked: 2,
      conflicted: 1,
      ahead: 2,
      behind: 1,
    });
  });

  test("a branch with no upstream reports no divergence", () => {
    const parsed = parseStatus("# branch.head main\n# branch.upstream \n");
    expect(parsed.ahead).toBeNull();
    expect(parsed.behind).toBeNull();
  });

  test("a clean tree counts nothing", () => {
    expect(parseStatus("# branch.head main\n# branch.ab +0 -0\n")).toEqual({
      modified: 0,
      untracked: 0,
      conflicted: 0,
      ahead: 0,
      behind: 0,
    });
  });
});
