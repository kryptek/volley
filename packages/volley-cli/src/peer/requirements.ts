import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * A repository's toolchain (#435): the tools an agent working in its clone needs, derived from
 * the manifests at the clone's root and merged with its optional `.volley/requirements.yaml`
 * (`tools: [...]`, `min: { <tool>: "<version>" }`; any other key is an error). Read on the
 * machine itself by the doctor, never through the supervisor's fence. A missing or outdated tool
 * blocks that repository only.
 */

export interface Requirements {
  /** Tool names, sorted: each is probed with `command -v`. */
  tools: string[];
  /** The lowest version a tool must report (`17`, `1.3`), by tool. */
  min: Record<string, string>;
}

/** The requirements file, relative to the clone's root. */
export const REQUIREMENTS_FILE = ".volley/requirements.yaml";

/** A tool's name: a word `command -v` reads as nothing but a name. */
const TOOL_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
/** A minimum version: digits and dots (`17`, `1.3`, `1.22.1`). */
const VERSION_RE = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
};

/** `bun@1.3.2` → `1.3.2`: the packageManager's version, when it is plain digits. */
const managerVersion = (pm: string, name: string): string | undefined => {
  const m = new RegExp(`^${name}@(\\d+(?:\\.\\d+){0,2})`).exec(pm);
  return m?.[1];
};

/** What the manifests at `root` need. */
function fromManifests(root: string): Requirements {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {}
  const has = (f: string) => names.includes(f);
  const tools = new Set<string>();
  const min: Record<string, string> = {};
  if (has("package.json")) {
    let pm = "";
    try {
      const pkg = JSON.parse(readText(join(root, "package.json")) ?? "{}") as {
        packageManager?: unknown;
      };
      if (typeof pkg.packageManager === "string") pm = pkg.packageManager;
    } catch {}
    if (pm.startsWith("bun@") || has("bun.lock") || has("bun.lockb")) {
      tools.add("bun");
      const v = managerVersion(pm, "bun");
      if (v !== undefined) min.bun = v;
    } else tools.add("node");
  }
  if (has("pom.xml")) {
    tools.add("java");
    // The Maven wrapper brings its own Maven.
    if (!has("mvnw")) tools.add("mvn");
  } else if (has("mvnw")) tools.add("java");
  if (has("build.gradle") || has("build.gradle.kts")) tools.add("java");
  if (has("go.mod")) {
    tools.add("go");
    const v = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(readText(join(root, "go.mod")) ?? "")?.[1];
    if (v !== undefined) min.go = v;
  }
  if (has("Cargo.toml")) tools.add("cargo");
  if (has("pyproject.toml") || has("requirements.txt")) tools.add("python3");
  if (has("Dockerfile") || names.some((n) => n.startsWith("docker-compose"))) tools.add("docker");
  return { tools: [...tools], min };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `.volley/requirements.yaml` at `root`, validated; null without one. Throws on a bad file. */
function fromFile(root: string): Requirements | null {
  const text = readText(join(root, REQUIREMENTS_FILE));
  if (text === null) return null;
  const bad = (why: string): never => {
    throw new Error(`${REQUIREMENTS_FILE}: ${why}`);
  };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    bad(`not YAML (${(e instanceof Error ? e.message : String(e)).split("\n")[0]})`);
  }
  if (doc === null || doc === undefined) return { tools: [], min: {} };
  if (!isRecord(doc)) return bad("must be a mapping of tools and min");
  for (const k of Object.keys(doc)) {
    if (k !== "tools" && k !== "min") bad(`unknown key "${k}" (allowed: tools, min)`);
  }
  const tools: string[] = [];
  if (doc.tools !== undefined) {
    if (!Array.isArray(doc.tools)) bad("tools must be a list of tool names");
    for (const t of doc.tools as unknown[]) {
      if (typeof t !== "string" || !TOOL_RE.test(t))
        bad(`tools: "${String(t)}" is not a tool name`);
      tools.push(t as string);
    }
  }
  const min: Record<string, string> = {};
  if (doc.min !== undefined) {
    if (!isRecord(doc.min)) bad("min must map a tool to its lowest version");
    for (const [t, v] of Object.entries(doc.min as Record<string, unknown>)) {
      if (!TOOL_RE.test(t)) bad(`min: "${t}" is not a tool name`);
      const s = typeof v === "number" ? String(v) : v;
      if (typeof s !== "string" || !VERSION_RE.test(s)) {
        bad(`min.${t}: "${String(v)}" is not a version (digits and dots, e.g. "17")`);
      }
      min[t] = s as string;
      // A minimum names a tool the repository needs.
      tools.push(t);
    }
  }
  return { tools, min };
}

/**
 * The toolchain the clone at `root` needs: its manifests' tools, plus the requirements file's
 * (whose `min` wins). Throws an Error naming the file when it is invalid.
 */
export function requirementsOf(root: string): Requirements {
  const derived = fromManifests(root);
  const file = existsSync(root) ? fromFile(root) : null;
  const tools = new Set([...derived.tools, ...(file?.tools ?? [])]);
  return { tools: [...tools].sort(), min: { ...derived.min, ...(file?.min ?? {}) } };
}

/** `version` is at least `min`, compared number by number (`1.10` > `1.9`; `17.0.2` ≥ `17`). */
export function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
