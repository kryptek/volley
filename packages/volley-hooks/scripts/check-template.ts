#!/usr/bin/env bun
/**
 * CI check: every hook command in settings.volley-hooks.json must point at a file that exists
 * under the package root (`$VOLLEY_HOOKS_DIR/<path>`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_REF = /\$\{?VOLLEY_HOOKS_DIR\}?\/([^"'\s]+)/;

export function checkTemplate(
  templatePath: string,
  packageRoot: string,
): { commands: string[]; missing: string[] } {
  const settings = JSON.parse(readFileSync(templatePath, "utf-8")) as {
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
  };
  const commands: string[] = [];
  const missing: string[] = [];
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook.command !== "string") continue;
        commands.push(hook.command);
        const ref = SCRIPT_REF.exec(hook.command)?.[1];
        if (ref === undefined || !existsSync(join(packageRoot, ref))) {
          missing.push(ref ?? hook.command);
        }
      }
    }
  }
  return { commands, missing };
}

if (import.meta.main) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { commands, missing } = checkTemplate(join(root, "settings.volley-hooks.json"), root);
  if (missing.length > 0) {
    console.error(`settings.volley-hooks.json: missing hook scripts: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`settings.volley-hooks.json: ${commands.length} hook commands, all present`);
}
