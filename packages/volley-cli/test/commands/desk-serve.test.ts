import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DeskServer, desk, startDeskServer } from "../../src/commands/desk-serve";
import { makeBufferIO } from "../../src/io";
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
