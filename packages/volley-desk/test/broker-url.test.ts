import { describe, expect, it } from "vitest";
import { DEFAULT_BROKER_URL, defaultBrokerUrl, resolveBrokerUrl } from "../src/store/context";

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
