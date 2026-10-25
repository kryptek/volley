import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROKER_URL,
  brokerSource,
  defaultBrokerUrl,
  fetchDeskConfig,
  resolveBrokerUrl,
} from "../src/store/context";

/** What a browser puts in `location` for `href` (IPv6 hostnames keep their brackets). */
const at = (href: string) => {
  const u = new URL(href);
  return { protocol: u.protocol, hostname: u.hostname };
};

describe("defaultBrokerUrl (the page host's mosquitto WebSocket listener)", () => {
  it("uses the host the page was loaded from", () => {
    expect(defaultBrokerUrl(at("http://localhost:5174/"))).toBe("ws://localhost:9001");
    expect(defaultBrokerUrl(at("http://192.0.2.10:5174/"))).toBe("ws://192.0.2.10:9001");
  });

  it("keeps an IPv6 host's brackets as the browser gives them (never doubled)", () => {
    expect(defaultBrokerUrl(at("http://[::1]:5174/"))).toBe("ws://[::1]:9001");
    expect(defaultBrokerUrl(at("http://[fe80::1]:5174/"))).toBe("ws://[fe80::1]:9001");
    expect(() => new URL(defaultBrokerUrl(at("http://[::1]:5174/")))).not.toThrow();
  });

  it("brackets a bare IPv6 hostname", () => {
    expect(defaultBrokerUrl({ hostname: "::1" })).toBe("ws://[::1]:9001");
  });

  it("uses wss for a page served over https (a ws:// socket would be blocked as mixed content)", () => {
    expect(defaultBrokerUrl(at("https://desk.example:443/"))).toBe("wss://desk.example:9001");
  });

  it("is ws://localhost:9001 outside a browser", () => {
    expect(defaultBrokerUrl(undefined)).toBe(DEFAULT_BROKER_URL);
    expect(defaultBrokerUrl({ hostname: "" })).toBe(DEFAULT_BROKER_URL);
    expect(DEFAULT_BROKER_URL).toBe("ws://localhost:9001");
  });
});

describe("resolveBrokerUrl precedence", () => {
  const env = { VITE_VOLLEY_BROKER_URL: "ws://env.test:9001" };
  const page = at("http://192.0.2.10:5174/");

  it("the prop beats VITE_VOLLEY_BROKER_URL", () => {
    expect(resolveBrokerUrl("ws://prop.test:9001", env, page)).toBe("ws://prop.test:9001");
  });

  it("VITE_VOLLEY_BROKER_URL beats the page host", () => {
    expect(resolveBrokerUrl(undefined, env, page)).toBe("ws://env.test:9001");
  });

  it("an empty or missing VITE_VOLLEY_BROKER_URL falls through to the page host", () => {
    expect(resolveBrokerUrl(undefined, { VITE_VOLLEY_BROKER_URL: "" }, page)).toBe(
      "ws://192.0.2.10:9001",
    );
    expect(resolveBrokerUrl(undefined, {}, at("http://[::1]:5174/"))).toBe("ws://[::1]:9001");
  });

  it("defaults to the browser's own location", () => {
    // jsdom serves the test page from http://localhost.
    expect(resolveBrokerUrl(undefined, {})).toBe("ws://localhost:9001");
  });
});

describe("resolveBrokerUrl with the served /desk-config.json", () => {
  const env = { VITE_VOLLEY_BROKER_URL: "ws://env.test:9001" };
  const page = at("http://192.0.2.10:5199/");
  const served = { broker: { host: "box-a", ws_port: 9001 } };

  it("prefers the served broker over the page host", () => {
    expect(resolveBrokerUrl(undefined, {}, page, served)).toBe("ws://box-a:9001");
    expect(brokerSource(undefined, {}, served)).toBe("served");
    expect(brokerSource(undefined, {}, null)).toBe("page host");
  });

  it("the env and the prop still win over it", () => {
    expect(resolveBrokerUrl(undefined, env, page, served)).toBe("ws://env.test:9001");
    expect(resolveBrokerUrl("ws://prop.test:9001", env, page, served)).toBe("ws://prop.test:9001");
    expect(brokerSource(undefined, env, served)).toBe("env");
    expect(brokerSource("ws://prop.test:9001", {}, served)).toBe("prop");
  });

  it("brackets a bare IPv6 host, keeps the served port, and uses wss on https", () => {
    expect(
      resolveBrokerUrl(undefined, {}, page, { broker: { host: "fe80::1", ws_port: 9443 } }),
    ).toBe("ws://[fe80::1]:9443");
    expect(resolveBrokerUrl(undefined, {}, at("https://desk.example/"), served)).toBe(
      "wss://box-a:9001",
    );
  });

  it("without a served config (null: none, or the fetch failed) it is the page host", () => {
    expect(resolveBrokerUrl(undefined, {}, page, null)).toBe("ws://192.0.2.10:9001");
  });
});

describe("resolveBrokerUrl with the served ws_url (the Desk on the tailnet)", () => {
  const served = {
    broker: { host: "desk.example.ts.net", ws_port: 8443 },
    ws_url: "wss://desk.example.ts.net:8443",
  };

  it("an https page opens ws_url as served", () => {
    expect(resolveBrokerUrl(undefined, {}, at("https://desk.example.ts.net/"), served)).toBe(
      "wss://desk.example.ts.net:8443",
    );
    expect(brokerSource(undefined, {}, served)).toBe("served");
  });

  it("a ws:// ws_url is used on an http page too", () => {
    const plain = { broker: { host: "box-a", ws_port: 9001 }, ws_url: "ws://box-a:9001" };
    expect(resolveBrokerUrl(undefined, {}, at("http://192.0.2.10:5199/"), plain)).toBe(
      "ws://box-a:9001",
    );
  });

  it("the same Desk loaded on the LAN over http keeps the LAN broker (its own host)", () => {
    // A page at http://<lan>:5199 is no secure context; a phone on the LAN may not be on the tailnet.
    expect(resolveBrokerUrl(undefined, {}, at("http://192.0.2.10:5199/"), served)).toBe(
      "ws://192.0.2.10:9001",
    );
  });

  it("the env and the prop still win over it", () => {
    const env = { VITE_VOLLEY_BROKER_URL: "ws://env.test:9001" };
    expect(resolveBrokerUrl(undefined, env, at("https://desk.example.ts.net/"), served)).toBe(
      "ws://env.test:9001",
    );
  });
});

describe("fetchDeskConfig", () => {
  const ok = (body: unknown) =>
    vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ) as unknown as typeof fetch;

  it("reads { broker: { host, ws_port } } from /desk-config.json, never from a cache", async () => {
    const f = ok({ broker: { host: "box-a", ws_port: 9001 } });
    expect(await fetchDeskConfig(f)).toEqual({ broker: { host: "box-a", ws_port: 9001 } });
    expect(f).toHaveBeenCalledWith("/desk-config.json", { cache: "no-store" });
  });

  it("reads ws_url beside the broker; drops one that is not a bare ws(s):// URL", async () => {
    const both = { broker: { host: "desk.example.ts.net", ws_port: 8443 } };
    expect(
      await fetchDeskConfig(ok({ ...both, ws_url: "wss://desk.example.ts.net:8443" })),
    ).toEqual({ ...both, ws_url: "wss://desk.example.ts.net:8443" });
    // An IPv6 literal in brackets, as `volley desk serve --ws-url` accepts and serves it.
    expect(await fetchDeskConfig(ok({ ...both, ws_url: "ws://[::1]:9001" }))).toEqual({
      ...both,
      ws_url: "ws://[::1]:9001",
    });
    for (const ws_url of [
      "https://x:8443",
      "wss://u:p@x:8443",
      "wss://x:8443/p",
      "ws://::1:9001",
      7,
      "",
    ]) {
      expect(await fetchDeskConfig(ok({ ...both, ws_url })), String(ws_url)).toEqual(both);
    }
  });

  it("is null on a 404, a network error, bad JSON or a malformed body", async () => {
    const notFound = vi.fn(async () => new Response("not found", { status: 404 }));
    expect(await fetchDeskConfig(notFound as unknown as typeof fetch)).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchDeskConfig(down as unknown as typeof fetch)).toBeNull();
    const html = vi.fn(async () => new Response("<!doctype html>", { status: 200 }));
    expect(await fetchDeskConfig(html as unknown as typeof fetch)).toBeNull();
    for (const body of [
      {},
      { broker: { host: "", ws_port: 9001 } },
      { broker: { host: "ws://x", ws_port: 9001 } },
      { broker: { host: "box-a", ws_port: 0 } },
      { broker: { host: "box-a", ws_port: "9001" } },
    ]) {
      expect(await fetchDeskConfig(ok(body)), JSON.stringify(body)).toBeNull();
    }
  });
});
