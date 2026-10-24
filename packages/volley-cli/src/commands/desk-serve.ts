import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { deskStamp, parseBrokerHost, readBundleVersion, readDeskStamp } from "../setup/desk-build";
import type { SetupDeps } from "../setup/step";
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
 *
 * `--broker-host <host>` (and `--broker-ws-port`, default 9001) serves `GET /desk-config.json`
 * `{ broker: { host, ws_port } }`, never cached: the page connects to that broker instead of the
 * host it came from, so the broker can live on another machine than the Desk. Without the flag
 * the route is a 404 and the page uses its own host. Only a host, never a URL or a login.
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

/** The broker's WebSocket port the page uses when `--broker-ws-port` is not given. */
export const BROKER_WS_PORT = 9001;

/** What `/desk-config.json` serves. */
export interface DeskConfig {
  broker: { host: string; ws_port: number };
}

/** volleyd's wave id grammar (SPEC §4.6.1). */
const WAVE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * The evidence file `urlPath` names under `home` (`/evidence/<wave>/release/<file>`), or null:
 * not that shape, a wave id that is not one, a file name with a separator or a leading dot, a
 * type not allowed, missing, or a symlink whose target is not directly in the folder. The name is decoded
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
    if (dirname(real) !== dir || EVIDENCE_TYPES[extname(real).toLowerCase()] === undefined)
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
  /** The broker the page connects to: served at `/desk-config.json` (a 404 when absent). */
  broker?: DeskConfig["broker"];
}): Promise<DeskServer> {
  const index = join(opts.root, "index.html");
  const config =
    opts.broker === undefined
      ? null
      : Buffer.from(
          JSON.stringify({ broker: { host: opts.broker.host, ws_port: opts.broker.ws_port } }),
        );
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if ((req.url ?? "").split("?")[0] === "/desk-config.json") {
      if (config === null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": config.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : config);
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
  /** `install` / `uninstall`: setup's deps (tests fake the machine); default the real ones. */
  setupDeps?: SetupDeps;
}

/**
 * `volley desk serve [--host] [--port] [--root] [--evidence] [--broker-host [--broker-ws-port]]
 * [--quiet]`, and `volley desk install | uninstall | check` (desk-install.ts).
 */
export async function desk(args: DeskArgs): Promise<ExitCode> {
  const [sub, ...rest] = args.argv;
  if (sub === "install" || sub === "uninstall" || sub === "check") {
    const m = await import("./desk-install");
    const run =
      sub === "install" ? m.deskInstall : sub === "uninstall" ? m.deskUninstall : m.deskCheck;
    if (rest.includes("--help") || rest.includes("-h")) {
      args.io.stdout(DESK_HELP);
      return EXIT.OK;
    }
    return run({
      argv: rest,
      env: args.env,
      io: args.io,
      ...(args.setupDeps !== undefined ? { setupDeps: args.setupDeps } : {}),
    });
  }
  return serve(args);
}

async function serve({ argv, io, until, ...given }: DeskArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        port: { type: "string" },
        root: { type: "string" },
        evidence: { type: "string" },
        "broker-host": { type: "string" },
        "broker-ws-port": { type: "string" },
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
  const brokerText = parsed.values["broker-host"] as string | undefined;
  const wsText = parsed.values["broker-ws-port"] as string | undefined;
  const brokerHost = brokerText === undefined ? undefined : parseBrokerHost(brokerText);
  if (brokerHost === null) {
    io.stderr(
      `volley desk serve: --broker-host must be a bare host (a name or an IP address; no scheme, path, port or login), got ${JSON.stringify(brokerText)}\n`,
    );
    return EXIT.USAGE;
  }
  if (wsText !== undefined && brokerHost === undefined) {
    io.stderr("volley desk serve: --broker-ws-port needs --broker-host\n");
    return EXIT.USAGE;
  }
  const wsPort = Number(wsText ?? BROKER_WS_PORT);
  if (wsText !== undefined && (!/^\d+$/.test(wsText) || wsPort < 1 || wsPort > 65_535)) {
    io.stderr("volley desk serve: --broker-ws-port must be a port number (1..65535)\n");
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
      ...(brokerHost !== undefined ? { broker: { host: brokerHost, ws_port: wsPort } } : {}),
    });
  } catch (e) {
    io.stderr(`volley desk serve: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  io.stdout(`Serving the Desk from ${root} on ${server.url} (sign-in required)\n`);
  if (brokerHost !== undefined) {
    const shown = brokerHost.includes(":") ? `[${brokerHost}]` : brokerHost;
    io.stdout(`The page connects to the broker ${shown}:${wsPort} (/desk-config.json)\n`);
  }
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

export const DESK_HELP = `Usage: volley desk serve [--host <addr>] [--port <n>] [--root <dir>] [--evidence <dir>]
                         [--broker-host <host> [--broker-ws-port <n>]] [--quiet]
       volley desk install [--port <n>] [--broker-host <host>] [--root <checkout>]
       volley desk uninstall
       volley desk check --url <http://host:port> --version <v>

Serve the built Volley Desk (packages/volley-desk/dist; build it with
\`bun run --cwd packages/volley-desk build\`) from a small static server. Unknown paths get
the index. The page signs in to the broker itself (its WebSocket listener, port 9001 on the
host the page came from, or the one --broker-host names); this server holds no credentials. \`volley setup\` installs it as a
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
  --broker-host <host>
                  The broker's host when it is not this machine: served to the page at
                  /desk-config.json ({"broker":{"host","ws_port"}}, never cached), which
                  connects there instead of the page's own host. A bare host only (a name
                  or an IP address), never a URL or a login. Without it the route is a 404.
  --broker-ws-port <n>
                  The broker's WebSocket port for --broker-host (default 9001)
  -q, --quiet     No stale-build warnings
  -h, --help      Show this help and exit

install builds the Desk in the checkout (--root, default this one) without the
VITE_VOLLEY_BROKER_* variables, stamps the build, and installs \`volley desk serve --host
0.0.0.0 --port <n> [--broker-host <host>]\` as this platform's service (launchd or systemd
--user); it records the port and the broker host in $VOLLEYD_HOME/setup.json, so a later
\`volley setup\` keeps them. A second run changes nothing. uninstall stops and removes the
service and keeps the build. check exits 0 when <url>/ answers 200 and <url>/version.json
is <v>, else 1: the health check a machine runs on itself.
`;
