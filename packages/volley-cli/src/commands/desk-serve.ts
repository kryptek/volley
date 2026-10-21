import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { deskStamp, readBundleVersion, readDeskStamp } from "../setup/desk-build";
import { findRepoRoot } from "./dash";

/**
 * `volley desk serve`: the built Desk (packages/volley-desk/dist) from a tiny static server, the
 * service `volley setup` installs so a phone can load it. Hashed assets are cached for good, the
 * index never, and every unknown path gets the index (the Desk routes inside the page). The page
 * signs in to the broker itself; this server holds no credential and proxies nothing.
 *
 * `--evidence <volleyd home>` (off by default) also serves a release train's evidence read-only:
 * `GET /evidence/<wave>/release/<file>` for a `.png .jpg .webp .txt .log .md .json` file directly
 * under `<home>/waves/<wave>/release/` (the Desk's Needs you window shows the screenshots and
 * reads the stage evidence JSON), nothing else: any other `/evidence/` path is a 404. Anyone who
 * can load the Desk can read those files, a LAN-trust choice like `volley setup --lan`.
 */

export const DESK_PORT = 5199;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** What the evidence route serves, by extension; text is plain text, never rendered. */
const EVIDENCE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** volleyd's wave id grammar (SPEC §4.6.1). */
const WAVE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * The evidence file `urlPath` names under `home` (`/evidence/<wave>/release/<file>`), or null:
 * not that shape, a wave id that is not one, a file name with a separator or a leading dot, a
 * type not allowed, missing, or a symlink whose target is outside the folder. The name is decoded
 * exactly once: it is joined to the folder as validated, never handed to a second decoder.
 */
export function resolveEvidenceFile(home: string, urlPath: string): string | null {
  const parts = (urlPath.split("?")[0]?.split("#")[0] ?? "").split("/");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "evidence" || parts[3] !== "release")
    return null;
  let wave: string;
  let file: string;
  try {
    wave = decodeURIComponent(parts[2] ?? "");
    file = decodeURIComponent(parts[4] ?? "");
  } catch {
    return null;
  }
  if (!WAVE_ID.test(wave)) return null;
  if (file === "" || file.startsWith(".") || /[/\\\0]/.test(file)) return null;
  if (EVIDENCE_TYPES[extname(file).toLowerCase()] === undefined) return null;
  try {
    const dir = realpathSync(join(home, "waves", wave, "release"));
    const real = realpathSync(join(dir, file));
    if (!real.startsWith(dir + sep) || EVIDENCE_TYPES[extname(real).toLowerCase()] === undefined)
      return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** packages/volley-desk/dist in this checkout, or null when the repo root is not found. */
export function defaultDeskRoot(): string | null {
  const repo = findRepoRoot();
  return repo === null ? null : join(repo, "packages", "volley-desk", "dist");
}

/** The file under `root` that `urlPath` names, or null (missing, a directory, or outside root). */
export function resolveDeskFile(root: string, urlPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split("?")[0]?.split("#")[0] ?? "/");
  } catch {
    return null;
  }
  if (path.includes("\0")) return null;
  const base = resolve(root);
  const file = resolve(base, `.${path.startsWith("/") ? path : `/${path}`}`);
  if (file !== base && !file.startsWith(base + sep)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

/**
 * The lines `volley desk serve` warns with at start (never a refusal): the build at `root` was not
 * made from the checkout's current Desk sources (`repo`'s `deskStamp`; skipped with no checkout),
 * or the bundle's `version.json` is not this volley's `version`.
 */
export function deskWarnings(opts: {
  root: string;
  repo: string | null;
  version: string;
}): string[] {
  const out: string[] = [];
  if (opts.repo !== null) {
    const now = deskStamp(opts.repo);
    const built = readDeskStamp(opts.root);
    if (built !== now) {
      out.push(
        `warning: the Desk build is stale (built from ${built ?? "unknown"}, the checkout is ${now}); run volley deploy or volley setup --repair`,
      );
    }
  }
  const bundle = readBundleVersion(opts.root);
  if (bundle !== opts.version) {
    out.push(`warning: the Desk bundle is ${bundle ?? "unknown"}, this volley is ${opts.version}`);
  }
  return out;
}

export interface DeskServer {
  url: string;
  close: () => Promise<void>;
}

export async function startDeskServer(opts: {
  root: string;
  host: string;
  port: number;
  /** volleyd's home: serve its release evidence under `/evidence/` (off when absent). */
  evidence?: string;
}): Promise<DeskServer> {
  const index = join(opts.root, "index.html");
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if (opts.evidence !== undefined && (req.url ?? "").startsWith("/evidence/")) {
      serveEvidence(opts.evidence, req.url ?? "", req.method === "HEAD", res);
      return;
    }
    const found = resolveDeskFile(opts.root, req.url ?? "/");
    const file = found ?? index;
    const isIndex = file === index;
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control":
        isIndex || !file.includes(`${sep}assets${sep}`)
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, opts.host, () => {
      server.off("error", fail);
      ok();
    });
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${host}:${addr.port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function serveEvidence(home: string, url: string, head: boolean, res: ServerResponse): void {
  const file = resolveEvidenceFile(home, url);
  let body: Buffer | null = null;
  try {
    body = file === null ? null : readFileSync(file);
  } catch {
    body = null;
  }
  if (file === null || body === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
    return;
  }
  res.writeHead(200, {
    "content-type": EVIDENCE_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  });
  res.end(head ? undefined : body);
}

export interface DeskArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
  /** Resolves when the server should stop (tests); the real CLI runs until a signal. */
  until?: Promise<void>;
  /** The checkout the stale-build check compares with (tests); default: this one. */
  repo?: string | null;
  /** This volley's version (tests); default: package.json's. */
  version?: string;
}

/** `volley desk serve [--host] [--port] [--root] [--evidence] [--quiet]`. */
export async function desk({ argv, io, until, ...given }: DeskArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        port: { type: "string" },
        root: { type: "string" },
        evidence: { type: "string" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volley desk: ${e instanceof Error ? e.message : String(e)}\n${DESK_HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(DESK_HELP);
    return EXIT.OK;
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "serve") {
    io.stderr(DESK_HELP);
    return EXIT.USAGE;
  }
  const portText = (parsed.values.port as string | undefined) ?? String(DESK_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65_535) {
    io.stderr("volley desk serve: --port must be a port number (0..65535)\n");
    return EXIT.USAGE;
  }
  const host = (parsed.values.host as string | undefined) ?? "127.0.0.1";
  const root = (parsed.values.root as string | undefined) ?? defaultDeskRoot();
  if (root === null || !existsSync(join(root, "index.html"))) {
    io.stderr(
      `volley desk serve: no built Desk at ${root ?? "packages/volley-desk/dist"}; build it with \`bun run --cwd packages/volley-desk build\` (vite build), or pass --root\n`,
    );
    return EXIT.ERROR;
  }
  const evidence = parsed.values.evidence as string | undefined;
  if (evidence !== undefined && !existsSync(join(evidence, "waves"))) {
    io.stderr(
      `volley desk serve: --evidence ${evidence} is not volleyd's home (no waves/ folder in it)\n`,
    );
    return EXIT.ERROR;
  }
  if (parsed.values.quiet !== true) {
    const repo = given.repo !== undefined ? given.repo : findRepoRoot();
    for (const w of deskWarnings({ root, repo, version: given.version ?? pkg.version })) {
      io.stderr(`${w}\n`);
    }
  }
  let server: DeskServer;
  try {
    server = await startDeskServer({
      root,
      host,
      port,
      ...(evidence !== undefined ? { evidence } : {}),
    });
  } catch (e) {
    io.stderr(`volley desk serve: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  io.stdout(`Serving the Desk from ${root} on ${server.url} (sign-in required)\n`);
  if (evidence !== undefined) {
    io.stdout(
      `Serving release evidence from ${join(evidence, "waves")}/<wave>/release/ (read-only, no sign-in)\n`,
    );
  }
  await (until ??
    new Promise<void>((ok) => {
      for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(s, () => ok());
    }));
  await server.close();
  return EXIT.OK;
}

export const DESK_HELP = `Usage: volley desk serve [--host <addr>] [--port <n>] [--root <dir>] [--evidence <dir>] [--quiet]

Serve the built Volley Desk (packages/volley-desk/dist; build it with
\`bun run --cwd packages/volley-desk build\`) from a small static server. Unknown paths get
the index. The page signs in to the broker itself (its WebSocket listener, port 9001 on the
host the page came from); this server holds no credentials. \`volley setup\` installs it as a
service on 0.0.0.0:${DESK_PORT}. At start it warns (and still serves) when the build is stale:
not made from this checkout's Desk sources, or its version.json is not this volley's version.

Options:
  --host <addr>   Interface to listen on (default 127.0.0.1; 0.0.0.0 for a phone on the LAN)
  --port <n>      Port (default ${DESK_PORT})
  --root <dir>    The built Desk (default packages/volley-desk/dist in this checkout)
  --evidence <dir>
                  volleyd's home: also serve release evidence read-only at
                  /evidence/<wave>/release/<file> (.png .jpg .webp .txt .log .md .json
                  directly under waves/<wave>/release/, nothing else) for the Needs you
                  window. Off by default: anyone who can load the Desk can read those
                  files without signing in, a LAN-trust choice like \`volley setup --lan\`.
  -q, --quiet     No stale-build warnings
  -h, --help      Show this help and exit
`;
