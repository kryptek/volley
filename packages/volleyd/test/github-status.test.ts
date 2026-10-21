import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GITHUB_STATUS_URL,
  fetchGithubStatus,
  githubStatusCache,
} from "../src/autopilot/github-status";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { FIXTURES } from "./helpers/fake-host";

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");
const respond = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("fetchGithubStatus", () => {
  it("an incident on Actions: incident, with the non-operational components", async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return new Response(fixture("githubstatus-incident.json"));
    }) as unknown as typeof fetch;
    const s = await fetchGithubStatus(f, 1000);
    expect(urls).toEqual([GITHUB_STATUS_URL]);
    expect(s.incident).toBe(true);
    expect(s.components).toEqual([{ name: "Actions", status: "major_outage" }]);
  });

  it("all operational: no incident", async () => {
    const s = await fetchGithubStatus(respond(fixture("githubstatus-ok.json")), 1000);
    expect(s).toEqual({ incident: false, components: [] });
  });

  it("an incident on a component that is not Actions or the API is not a CI incident", async () => {
    const body = JSON.stringify({
      components: [{ name: "Codespaces", status: "major_outage" }],
    });
    expect((await fetchGithubStatus(respond(body), 1000)).incident).toBe(false);
  });

  it("a fetch that throws, a non-2xx or junk: unknown, never an incident", async () => {
    const throws = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    for (const f of [throws, respond("oops", 503), respond("not json")])
      expect(await fetchGithubStatus(f, 1000)).toEqual({
        incident: false,
        components: [],
        unknown: true,
      });
  });

  it("a fetch that never answers times out as unknown", async () => {
    const hangs = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await fetchGithubStatus(hangs, 20)).toMatchObject({ incident: false, unknown: true });
  });
});

describe("githubStatusCache", () => {
  it("a second read within status_page_cache_ms does not fetch; after it, it does", async () => {
    let fetches = 0;
    let now = 1_000_000;
    const f = (async () => {
      fetches++;
      return new Response(fixture("githubstatus-ok.json"));
    }) as unknown as typeof fetch;
    const cache = githubStatusCache(f, () => now);
    await cache();
    await cache();
    expect(fetches).toBe(1);
    now += DAEMON_DEFAULTS.status_page_cache_ms;
    await cache();
    expect(fetches).toBe(2);
  });
});
