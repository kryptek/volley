import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DeskServer,
  desk,
  deskWarnings,
  startDeskServer,
} from "../../src/commands/desk-serve";
import { makeBufferIO } from "../../src/io";
import { DESK_STAMP, deskStamp } from "../../src/setup/desk-build";
import { tempDir } from "../helpers/tmp";

describe("volley desk serve", () => {
  let root: string;
  let server: DeskServer | null = null;
  beforeEach(() => {
    // The root sits one level down, so the file "outside the root" below is still in a temp dir.
    root = join(tempDir("volley-desk-serve-"), "root");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Desk</title>");
    writeFileSync(join(root, "assets", "index-abc123.js"), "console.log('desk')");
    writeFileSync(join(root, "assets", "index-abc123.css"), "body{}");
    writeFileSync(join(root, "favicon.svg"), "<svg/>");
  });
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const serve = async () => {
    server = await startDeskServer({ root, host: "127.0.0.1", port: 0 });
    return server.url;
  };

  it("serves the built index and its assets with their content types", async () => {
    const url = await serve();
    const index = await fetch(`${url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.text()).toContain("<title>Desk</title>");

    const js = await fetch(`${url}/assets/index-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // Vite's hashed assets never change under one name.
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe("console.log('desk')");

    const css = await fetch(`${url}/assets/index-abc123.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const svg = await fetch(`${url}/favicon.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("falls back to the index for unknown paths (the Desk routes in the page)", async () => {
    const url = await serve();
    for (const path of ["/waves/w1", "/nope.js", "/assets/", "/index.html?x=1"]) {
      const r = await fetch(`${url}${path}`);
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).toContain("<title>Desk</title>");
    }
  });

  it("never serves a file outside the root", async () => {
    writeFileSync(join(root, "..", `${root.split("/").pop()}-secret.txt`), "secret");
    const url = await serve();
    for (const path of [
      `/../${root.split("/").pop()}-secret.txt`,
      `/%2e%2e/${root.split("/").pop()}-secret.txt`,
      "/..%2fetc%2fpasswd",
    ]) {
      const r = await fetch(`${url}${path}`);
      expect(await r.text(), path).not.toContain("secret");
    }
  });

  it("answers only GET and HEAD", async () => {
    const url = await serve();
    expect((await fetch(`${url}/`, { method: "POST" })).status).toBe(405);
    const head = await fetch(`${url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("refuses to start without a built Desk, naming the build command", async () => {
    const io = makeBufferIO();
    const code = await desk({
      argv: ["serve", "--root", join(root, "missing")],
      env: {},
      io,
    });
    expect(code).toBe(1);
    expect(io.readStderr()).toContain("no built Desk");
    expect(io.readStderr()).toContain("vite build");
  });

  it("validates its flags", async () => {
    const io = makeBufferIO();
    expect(await desk({ argv: ["serve", "--port", "http"], env: {}, io })).toBe(2);
    expect(io.readStderr()).toContain("--port");
    const io2 = makeBufferIO();
    expect(await desk({ argv: ["frobnicate"], env: {}, io: io2 })).toBe(2);
    const io3 = makeBufferIO();
    expect(await desk({ argv: ["serve", "--help"], env: {}, io: io3 })).toBe(0);
    expect(io3.readStdout()).toContain("5199");
  });
});

describe("volley desk serve: the stale-build warnings", () => {
  let repo: string;
  let root: string;
  beforeEach(() => {
    repo = tempDir("volley-desk-stale-");
    writeFileSync(join(repo, "bun.lock"), "{}");
    mkdirSync(join(repo, "packages", "volley-desk", "src"), { recursive: true });
    writeFileSync(join(repo, "packages", "volley-desk", "src", "main.ts"), "export {};");
    root = join(repo, "packages", "volley-desk", "dist");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Desk</title>");
  });
  const fresh = (version = "0.5.0") => {
    writeFileSync(join(root, DESK_STAMP), `${deskStamp(repo)}\n`);
    writeFileSync(join(root, "version.json"), JSON.stringify({ version }));
  };
  const STALE =
    /^warning: the Desk build is stale \(built from .+, the checkout is [0-9a-f]{16}\); run volley deploy or volley setup --repair$/;

  it("says nothing when the build is from this checkout and this version", () => {
    fresh();
    expect(deskWarnings({ root, repo, version: "0.5.0" })).toEqual([]);
  });

  it("warns when the stamp is missing or differs", () => {
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "0.5.0" }));
    const missing = deskWarnings({ root, repo, version: "0.5.0" });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(STALE);
    expect(missing[0]).toContain("built from unknown");
    writeFileSync(join(root, DESK_STAMP), "0123456789abcdef\n");
    const differs = deskWarnings({ root, repo, version: "0.5.0" });
    expect(differs[0]).toContain("built from 0123456789abcdef");
    expect(differs[0]).toContain(`the checkout is ${deskStamp(repo)}`);
  });

  it("warns when the bundle's version differs from this volley's", () => {
    fresh("0.4.0");
    expect(deskWarnings({ root, repo, version: "0.5.0" })).toEqual([
      "warning: the Desk bundle is 0.4.0, this volley is 0.5.0",
    ]);
  });

  it("gives both lines when both hold; with no checkout only the version line", () => {
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "0.4.0" }));
    const both = deskWarnings({ root, repo, version: "0.5.0" });
    expect(both).toHaveLength(2);
    expect(both[0]).toMatch(STALE);
    expect(both[1]).toBe("warning: the Desk bundle is 0.4.0, this volley is 0.5.0");
    expect(deskWarnings({ root, repo: null, version: "0.5.0" })).toEqual([
      "warning: the Desk bundle is 0.4.0, this volley is 0.5.0",
    ]);
  });

  it("calls a bundle without version.json unknown", () => {
    writeFileSync(join(root, DESK_STAMP), `${deskStamp(repo)}\n`);
    expect(deskWarnings({ root, repo, version: "0.5.0" })).toEqual([
      "warning: the Desk bundle is unknown, this volley is 0.5.0",
    ]);
  });

  const serveOnce = async (argv: string[]) => {
    const io = makeBufferIO();
    let stop: () => void = () => {};
    const until = new Promise<void>((ok) => {
      stop = ok;
    });
    const running = desk({
      argv: ["serve", "--port", "0", "--root", root, ...argv],
      env: {},
      io,
      until,
      repo,
      version: "0.5.0",
    });
    // The server is up once it has said where.
    for (let i = 0; i < 200 && !io.readStdout().includes("Serving the Desk"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    stop();
    return { code: await running, io };
  };

  it("prints the warnings to stderr before serving, and still serves", async () => {
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "0.4.0" }));
    const { code, io } = await serveOnce([]);
    expect(code).toBe(0);
    expect(io.readStdout()).toContain("Serving the Desk from");
    const lines = io.readStderr().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(STALE);
    expect(lines[1]).toBe("warning: the Desk bundle is 0.4.0, this volley is 0.5.0");
  });

  it("--quiet prints neither", async () => {
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "0.4.0" }));
    const { code, io } = await serveOnce(["--quiet"]);
    expect(code).toBe(0);
    expect(io.readStdout()).toContain("Serving the Desk from");
    expect(io.readStderr()).toBe("");
  });
});

describe("volley desk serve --evidence: the release evidence route", () => {
  let root: string;
  let home: string;
  let server: DeskServer | null = null;
  beforeEach(() => {
    const base = tempDir("volley-desk-evidence-");
    root = join(base, "dist");
    home = join(base, "volleyd");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Desk</title>");
    const rel = join(home, "waves", "w1", "release");
    mkdirSync(join(rel, "sub"), { recursive: true });
    writeFileSync(join(rel, "smoke.png"), "PNGDATA");
    writeFileSync(join(rel, "shot.jpg"), "JPGDATA");
    writeFileSync(join(rel, "shot.webp"), "WEBPDATA");
    writeFileSync(join(rel, "smoke.log"), "log line");
    writeFileSync(join(rel, "notes.txt"), "notes");
    writeFileSync(join(rel, "tag.md"), "# Release stage");
    writeFileSync(join(rel, "tag.json"), '{"stage":"tag"}');
    writeFileSync(join(rel, "evil.html"), "<script>alert(1)</script>");
    writeFileSync(join(rel, "evil.svg"), "<svg onload=alert(1)/>");
    writeFileSync(join(rel, "sub", "deep.png"), "DEEP");
    writeFileSync(join(rel, ".hidden.png"), "HIDDEN");
    writeFileSync(join(home, "outside.png"), "SECRETCONFIG");
    symlinkSync(join(home, "outside.png"), join(rel, "link.png"));
    symlinkSync(join(rel, "evil.html"), join(rel, "alias.png"));
    writeFileSync(join(home, "waves", "w1", "journal.jsonl"), "JOURNAL");
    writeFileSync(join(home, "config.yaml"), "SECRETCONFIG");
  });
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const serve = async (evidence?: string) => {
    server = await startDeskServer({
      root,
      host: "127.0.0.1",
      port: 0,
      ...(evidence !== undefined ? { evidence } : {}),
    });
    return server.url;
  };

  it("is off by default: the path is the Desk's index, never the file", async () => {
    const url = await serve();
    const r = await fetch(`${url}/evidence/w1/release/smoke.png`);
    expect(await r.text()).toContain("<title>Desk</title>");
  });

  it("serves the allowed types directly under waves/<wave>/release/, read-only", async () => {
    const url = await serve(home);
    const cases: [string, string, string][] = [
      ["smoke.png", "image/png", "PNGDATA"],
      ["shot.jpg", "image/jpeg", "JPGDATA"],
      ["shot.webp", "image/webp", "WEBPDATA"],
      ["smoke.log", "text/plain; charset=utf-8", "log line"],
      ["notes.txt", "text/plain; charset=utf-8", "notes"],
      ["tag.md", "text/plain; charset=utf-8", "# Release stage"],
      ["tag.json", "application/json; charset=utf-8", '{"stage":"tag"}'],
    ];
    for (const [file, type, body] of cases) {
      const r = await fetch(`${url}/evidence/w1/release/${file}`);
      expect(r.status, file).toBe(200);
      expect(r.headers.get("content-type"), file).toBe(type);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
      expect(await r.text(), file).toBe(body);
    }
    expect((await fetch(`${url}/evidence/w1/release/smoke.png`, { method: "POST" })).status).toBe(
      405,
    );
  });

  it("refuses every other type, a missing file, a subfolder and any traversal with a 404", async () => {
    const url = await serve(home);
    for (const path of [
      "/evidence/w1/release/evil.html",
      "/evidence/w1/release/evil.svg",
      "/evidence/w1/release/missing.png",
      "/evidence/w1/release/sub/deep.png",
      "/evidence/w1/release/sub%2fdeep.png",
      "/evidence/w1/release/../journal.jsonl",
      "/evidence/w1/release/..%2fjournal.jsonl",
      "/evidence/w1/release/%2e%2e%2f%2e%2e%2f..%2fconfig.yaml",
      "/evidence/w1/release/..%5c..%5cconfig.yaml",
      "/evidence/../config.yaml",
      "/evidence/%2e%2e/release/smoke.png",
      "/evidence/W1!/release/smoke.png",
      "/evidence/w1/release/",
      "/evidence/w1/release/.hidden.png",
      "/evidence/w1/release/%252ehidden.png",
      "/evidence/w1/release/sub%252fdeep.png",
      "/evidence/w1/release/link.png",
      "/evidence/w1/release/alias.png",
      "/evidence/w1/journal.jsonl",
    ]) {
      const r = await fetch(`${url}${path}`);
      const text = await r.text();
      // fetch normalises dot segments: one that leaves /evidence/ is the Desk's index, not a file.
      if (new URL(path, url).pathname.startsWith("/evidence/")) expect(r.status, path).toBe(404);
      expect(text, path).not.toContain("JOURNAL");
      expect(text, path).not.toContain("SECRETCONFIG");
      expect(text, path).not.toContain("<script>");
      expect(text, path).not.toContain("DEEP");
      expect(text, path).not.toContain("HIDDEN");
    }
  });

  it("--evidence is a flag of desk serve, and a missing folder refuses to start", async () => {
    const io = makeBufferIO();
    const code = await desk({
      argv: ["serve", "--root", root, "--evidence", join(home, "nope")],
      env: {},
      io,
    });
    expect(code).toBe(1);
    expect(io.readStderr()).toContain("--evidence");
    const help = makeBufferIO();
    await desk({ argv: ["serve", "--help"], env: {}, io: help });
    expect(help.readStdout()).toContain("--evidence <dir>");
    expect(help.readStdout()).toMatch(/LAN/);
  });
});
