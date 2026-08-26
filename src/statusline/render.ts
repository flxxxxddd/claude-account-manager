/** Assembles configured segments into the lines Claude Code prints. */
import { c, visibleLength } from "../ui.ts";
import { segments, type RenderContext } from "./segments.ts";

const SEPARATOR = " │ ";

export function renderLines(ctx: RenderContext): string[] {
  return ctx.config.statusline.lines
    .map((names) =>
      names
        .map((name) => segments[name]?.(ctx) ?? null)
        .filter((part): part is string => part !== null && part.length > 0)
        .join(c.gray(SEPARATOR)),
    )
    .filter((line) => visibleLength(line) > 0);
}
