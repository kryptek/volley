#!/usr/bin/env bun
/**
 * CI check: every hook command (and the statusLine command) in settings.volley-hooks.json must
 * point at a file that exists under the package root (`$VOLLEY_HOOKS_DIR/<path>`), and an
 * `asyncRewake` entry (the owner-wake waiter) must also be `async` with a numeric `timeout`:
 * Claude Code enforces it, and the waiter's own fallback wake fires below it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_REF = /\$\{?VOLLEY_HOOKS_DIR\}?\/([^"'\s]+)/;

export function checkTemplate(
  templatePath: string,
  packageRoot: string,
): { commands: string[]; missing: string[]; invalid: string[] } {
  const settings = JSON.parse(readFileSync(templatePath, "utf-8")) as {
    statusLine?: { command?: string };
    hooks?: Record<
      string,
      {
        hooks?: { command?: string; async?: unknown; asyncRewake?: unknown; timeout?: unknown }[];
      }[]
    >;
  };
  const entries = [
    settings.statusLine,
    ...Object.values(settings.hooks ?? {}).flatMap((groups) =>
      groups.flatMap((group) => group.hooks ?? []),
    ),
  ];
  const commands: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (typeof entry?.command !== "string") continue;
    commands.push(entry.command);
    const e = entry as { asyncRewake?: unknown; async?: unknown; timeout?: unknown };
    if (e.asyncRewake === true && (e.async !== true || typeof e.timeout !== "number"))
      invalid.push(`${entry.command}: asyncRewake needs async: true and a numeric timeout`);
    const ref = SCRIPT_REF.exec(entry.command)?.[1];
    if (ref === undefined || !existsSync(join(packageRoot, ref))) {
      missing.push(ref ?? entry.command);
    }
  }
  return { commands, missing, invalid };
}

if (import.meta.main) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { commands, missing, invalid } = checkTemplate(
    join(root, "settings.volley-hooks.json"),
    root,
  );
  if (missing.length > 0) {
    console.error(`settings.volley-hooks.json: missing hook scripts: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (invalid.length > 0) {
    console.error(`settings.volley-hooks.json: ${invalid.join("; ")}`);
    process.exit(1);
  }
  console.log(`settings.volley-hooks.json: ${commands.length} hook commands, all present`);
}
