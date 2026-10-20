import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

/** `spec/schemas/` at the repo root — the package runs from source, so the path is stable. */
export const SCHEMAS_DIR = fileURLToPath(new URL("../../../spec/schemas/", import.meta.url));

const SCHEMA_BASE = "https://volley.systems/schemas/0.1/";

let ajv: Ajv2020 | null = null;

function instance(): Ajv2020 {
  if (ajv !== null) return ajv;
  const a = new Ajv2020({ allErrors: true, strict: false });
  addFormats(a);
  for (const f of readdirSync(SCHEMAS_DIR)) {
    if (!f.endsWith(".schema.json")) continue;
    a.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, f), "utf-8")));
  }
  ajv = a;
  return a;
}

/** A compiled validator for `<file>[#<pointer>]`, e.g. `config.schema.json#/$defs/tunables`. */
export function validator(ref: string): ValidateFunction {
  const v = instance().getSchema(SCHEMA_BASE + ref);
  if (v === undefined) throw new Error(`schema not found: ${ref}`);
  return v;
}

/** One validation failure, path-qualified the way volleyd reports errors. */
export interface PathError {
  path: string;
  reason: string;
}

/** `/tasks/T3/after/1` → `tasks.T3.after[1]`. The empty pointer becomes `(root)`. */
export function pointerToPath(pointer: string): string {
  const segs = pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let out = "";
  for (const s of segs) {
    if (/^[0-9]+$/.test(s)) out += `[${s}]`;
    else out += out === "" ? s : `.${s}`;
  }
  return out === "" ? "(root)" : out;
}

function joinPath(base: string, key: string): string {
  return base === "(root)" ? key : `${base}.${key}`;
}

/**
 * Turn ajv errors into deduplicated `{ path, reason }` pairs. Unknown keys are reported at the
 * key's own path; `oneOf`/`if` noise is dropped when a more specific error covers the same path.
 */
export function toPathErrors(errors: ErrorObject[] | null | undefined): PathError[] {
  const out: PathError[] = [];
  const seen = new Set<string>();
  const push = (path: string, reason: string) => {
    const k = `${path}\u0000${reason}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ path, reason });
  };
  const list = errors ?? [];
  for (const e of list) {
    const base = pointerToPath(e.instancePath);
    if (e.keyword === "additionalProperties") {
      push(joinPath(base, String(e.params.additionalProperty)), "unknown key");
    } else if (e.keyword === "unevaluatedProperties") {
      push(joinPath(base, String(e.params.unevaluatedProperty)), "unknown key");
    } else if (e.keyword === "oneOf" || e.keyword === "anyOf") {
      // Only meaningful when nothing more specific was reported at or under this path.
      if (
        !list.some(
          (o) => o !== e && o.instancePath.startsWith(e.instancePath) && o.keyword !== e.keyword,
        )
      ) {
        push(base, e.message ?? "invalid");
      }
    } else {
      push(base, e.message ?? "invalid");
    }
  }
  return out;
}
