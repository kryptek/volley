#!/usr/bin/env bun
/**
 * Volley schema validation script.
 *
 * Walks `spec/examples/valid/` and asserts each example passes the appropriate
 * channel schema. Walks `spec/examples/invalid/` and asserts each example FAILS.
 *
 * Channel selection: parsed from the filename prefix.
 *   - `status-*.json` -> status.schema.json
 *   - `progress-*.json` -> progress.schema.json
 *   - `mailbox-*.json` -> mailbox.schema.json
 *   - `registry-*.json` -> registry.schema.json
 *   - `result-*.json` -> result.schema.json
 *   - `capability-*.json` -> capability.schema.json
 *   - `envelope-*.json` -> envelope.schema.json (envelope-level violations only)
 *   - `wave-*.json` -> wave-state.schema.json
 *   - `waveevent-*.json` -> wave-event.schema.json
 *   - `wavefile-*.json` -> wave-file.schema.json (a file, not an envelope)
 *   - `decision-*.json` -> decision.schema.json
 *   - `inbox-*.json` -> inbox-item.schema.json
 *   - `lease-*.json` -> lease-pool.schema.json
 *   - `leasereq-*.json` -> lease-request.schema.json
 *   - `identity-*.json` -> agent-identity.schema.json (a file, not an envelope)
 *   - `config-*.json` -> config.schema.json
 *   - `configset-*.json` -> config-set-request.schema.json
 *   - `screen-*.json` -> screen.schema.json
 *   - `admission-*.json` -> admission.schema.json
 *   - `account-*.json` -> account.schema.json (a file, not an envelope)
 *   - `authreq-*.json` -> auth-request.schema.json
 *   - `usage-*.json` -> usage.schema.json
 *   - `claudeaccount-*.json` -> claude-account.schema.json
 *   - `machine-*.json` -> machine.schema.json
 *   - `readiness-*.json` -> readiness.schema.json
 *   - `setupplan-*.json` -> setup-result.schema.json `$defs/plan` (a result, not an envelope)
 *   - `setupapply-*.json` -> setup-result.schema.json `$defs/applied` (a result, not an envelope)
 *
 * Exit code 0 on success; non-zero on any unexpected pass/fail.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCHEMAS_DIR = join(REPO_ROOT, "spec/schemas");
const EXAMPLES_DIR = join(REPO_ROOT, "spec/examples");

const PREFIX_TO_SCHEMA: Record<string, string> = {
  envelope: "envelope.schema.json",
  status: "status.schema.json",
  progress: "progress.schema.json",
  mailbox: "mailbox.schema.json",
  registry: "registry.schema.json",
  result: "result.schema.json",
  capability: "capability.schema.json",
  wave: "wave-state.schema.json",
  waveevent: "wave-event.schema.json",
  wavefile: "wave-file.schema.json",
  decision: "decision.schema.json",
  inbox: "inbox-item.schema.json",
  lease: "lease-pool.schema.json",
  leasereq: "lease-request.schema.json",
  identity: "agent-identity.schema.json",
  config: "config.schema.json",
  configset: "config-set-request.schema.json",
  screen: "screen.schema.json",
  admission: "admission.schema.json",
  account: "account.schema.json",
  authreq: "auth-request.schema.json",
  usage: "usage.schema.json",
  claudeaccount: "claude-account.schema.json",
  machine: "machine.schema.json",
  readiness: "readiness.schema.json",
  setupplan: "setup-result.schema.json#/$defs/plan",
  setupapply: "setup-result.schema.json#/$defs/applied",
};

async function loadSchemas(ajv: Ajv2020): Promise<void> {
  const files = await readdir(SCHEMAS_DIR);
  for (const f of files) {
    if (!f.endsWith(".schema.json")) continue;
    const raw = await readFile(join(SCHEMAS_DIR, f), "utf-8");
    let schema: unknown;
    try {
      schema = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse schema ${f}: ${(e as Error).message}`);
    }
    ajv.addSchema(schema as Parameters<typeof ajv.addSchema>[0], f);
  }
}

function schemaForExample(filename: string): string | null {
  const prefix = filename.split("-")[0];
  if (!prefix) return null;
  return PREFIX_TO_SCHEMA[prefix] ?? null;
}

async function validateDir(
  ajv: Ajv2020,
  dir: string,
  expectValid: boolean,
): Promise<{ ok: number; fail: number; failures: string[] }> {
  const files = await readdir(dir).catch(() => []);
  let ok = 0;
  let fail = 0;
  const failures: string[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const schemaFile = schemaForExample(f);
    if (!schemaFile) {
      failures.push(`${f}: cannot infer schema from filename prefix`);
      fail++;
      continue;
    }
    const validator = ajv.getSchema(schemaFile);
    if (!validator) {
      failures.push(`${f}: schema ${schemaFile} not loaded`);
      fail++;
      continue;
    }
    const raw = await readFile(join(dir, f), "utf-8");
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      failures.push(`${f}: malformed JSON — ${(e as Error).message}`);
      fail++;
      continue;
    }
    const result = validator(data);
    if (result instanceof Promise) {
      throw new Error(`${schemaFile} is an async schema — sync-only validation expected`);
    }
    const isValid: boolean = result;
    if (isValid === expectValid) {
      ok++;
    } else {
      fail++;
      const errs = validator.errors
        ? validator.errors.map((e) => `${e.instancePath} ${e.message}`).join("; ")
        : "(no error details)";
      failures.push(
        `${f}: expected ${expectValid ? "VALID" : "INVALID"}, got ${isValid ? "VALID" : "INVALID"}; errors=${errs}`,
      );
    }
  }
  return { ok, fail, failures };
}

async function main(): Promise<void> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  await loadSchemas(ajv);

  const valid = await validateDir(ajv, join(EXAMPLES_DIR, "valid"), true);
  const invalid = await validateDir(ajv, join(EXAMPLES_DIR, "invalid"), false);

  console.log(`valid/   examples — ${valid.ok} ok, ${valid.fail} fail`);
  console.log(`invalid/ examples — ${invalid.ok} ok, ${invalid.fail} fail`);
  for (const f of [...valid.failures, ...invalid.failures]) {
    console.error(`  ✗ ${f}`);
  }

  const totalFail = valid.fail + invalid.fail;
  if (totalFail > 0) {
    console.error(`\n${totalFail} failure(s).`);
    process.exit(1);
  }
  console.log(`\nAll ${valid.ok + invalid.ok} examples validated correctly.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
