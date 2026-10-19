import { existsSync, readFileSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { findRepoRoot } from "./dash";

/**
 * `volley desk serve`: the built Desk (packages/volley-desk/dist) from a tiny static server, the
 * service `volley setup` installs so a phone can load it. Hashed assets are cached for good, the
 * index never, and every unknown path gets the index (the Desk routes inside the page). The page
 * signs in to the broker itself; this server holds no credential and proxies nothing.
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

export interface DeskServer {
  url: string;
  close: () => Promise<void>;
}

export async function startDeskServer(opts: {
  root: string;
  host: string;
  port: number;
}): Promise<DeskServer> {
  const index = join(opts.root, "index.html");
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
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

export interface DeskArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
  /** Resolves when the server should stop (tests); the real CLI runs until a signal. */
  until?: Promise<void>;
}

/** `volley desk serve [--host] [--port] [--root]`. */
export async function desk({ argv, io, until }: DeskArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        port: { type: "string" },
        root: { type: "string" },
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
  let server: DeskServer;
  try {
    server = await startDeskServer({ root, host, port });
  } catch (e) {
    io.stderr(`volley desk serve: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  io.stdout(`Serving the Desk from ${root} on ${server.url} (sign-in required)\n`);
  await (until ??
    new Promise<void>((ok) => {
      for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(s, () => ok());
    }));
  await server.close();
  return EXIT.OK;
}

export const DESK_HELP = `Usage: volley desk serve [--host <addr>] [--port <n>] [--root <dir>]

Serve the built Volley Desk (packages/volley-desk/dist; build it with
\`bun run --cwd packages/volley-desk build\`) from a small static server. Unknown paths get
the index. The page signs in to the broker itself (its WebSocket listener, port 9001 on the
host the page came from); this server holds no credentials. \`volley setup\` installs it as a
service on 0.0.0.0:${DESK_PORT}.

Options:
  --host <addr>   Interface to listen on (default 127.0.0.1; 0.0.0.0 for a phone on the LAN)
  --port <n>      Port (default ${DESK_PORT})
  --root <dir>    The built Desk (default packages/volley-desk/dist in this checkout)
  -h, --help      Show this help and exit
`;
