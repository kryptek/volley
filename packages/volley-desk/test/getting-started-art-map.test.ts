import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ART_MAP_URL, parseArtMap } from "../src/getting-started/art/assetMap";

describe("parseArtMap", () => {
  it("accepts a scene's raster file name", () => {
    expect(parseArtMap({ version: 1, scenes: { repos: "repos.webp" } })).toEqual({
      repos: "repos.webp",
    });
  });

  it("drops unknown scene ids and non-string names", () => {
    expect(
      parseArtMap({ version: 1, scenes: { repos: "r.png", lobby: "l.png", done: 3, people: "" } }),
    ).toEqual({ repos: "r.png" });
  });

  it.each(["../x.png", "a/b.png", "https://x/y.png", "data:image/png;base64,AA", "a\\b.png", ".."])(
    "rejects %s",
    (name) => {
      expect(parseArtMap({ version: 1, scenes: { repos: name } })).toEqual({});
    },
  );

  it.each([null, undefined, "art", 7, [], {}, { version: 1 }, { scenes: "x" }, { scenes: [] }])(
    "yields {} for %j",
    (raw) => {
      expect(parseArtMap(raw)).toEqual({});
    },
  );

  it("reads the map from the public folder", () => {
    expect(ART_MAP_URL).toBe("/getting-started/art.json");
  });
});

describe("the shipped art.json", () => {
  it("is an empty map", () => {
    const file = path.resolve(__dirname, "../public/getting-started/art.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, scenes: {} });
  });
});
