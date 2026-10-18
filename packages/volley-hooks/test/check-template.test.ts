import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTemplate } from "../scripts/check-template";
import { PACKAGE_ROOT } from "./helpers/hooks";

describe("settings template", () => {
  it("every command resolves to an existing hook script", () => {
    const result = checkTemplate(join(PACKAGE_ROOT, "settings.volley-hooks.json"), PACKAGE_ROOT);
    expect(result.missing).toEqual([]);
    expect(result.commands.length).toBeGreaterThanOrEqual(7);
  });

  it("reports a command whose script does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "volley-hooks-tpl-"));
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: 'bun "$VOLLEY_HOOKS_DIR/src/hooks/nope.ts"' }] },
          ],
        },
      }),
    );
    expect(checkTemplate(path, PACKAGE_ROOT).missing).toEqual(["src/hooks/nope.ts"]);
  });
});
