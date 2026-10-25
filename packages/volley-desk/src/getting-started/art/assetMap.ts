/**
 * The asset map: `public/getting-started/art.json` names a raster file for each scene that has
 * one (`{ "version": 1, "scenes": { "repos": "repos.webp" } }`), served from the same folder.
 * A scene the map does not name draws its vector scene. The map is fetched once per page load;
 * a missing, unreachable or malformed map is an empty one.
 */
import { useEffect, useState } from "react";
import { type SceneId, isSceneId } from "./ids";

export const ART_MAP_URL = "/getting-started/art.json";

/** The folder the map's file names resolve against. */
export const ART_DIR_URL = "/getting-started/";

export type ArtMap = Partial<Record<SceneId, string>>;

/** A bare file name: no path separator, no `..`, no scheme. */
const safeName = (s: string): boolean =>
  s.length > 0 && !/[/\\:]/.test(s) && !s.includes("..") && s.trim() === s;

/** Pure: the scenes of a parsed `art.json` whose file names are safe; anything else is `{}`. */
export function parseArtMap(raw: unknown): ArtMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const scenes = (raw as { scenes?: unknown }).scenes;
  if (!scenes || typeof scenes !== "object" || Array.isArray(scenes)) return {};
  const out: ArtMap = {};
  for (const [id, name] of Object.entries(scenes)) {
    if (isSceneId(id) && typeof name === "string" && safeName(name)) out[id] = name;
  }
  return out;
}

let pending: Promise<ArtMap> | null = null;

function loadArtMap(): Promise<ArtMap> {
  pending ??= fetch(ART_MAP_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then(parseArtMap, () => ({}));
  return pending;
}

/** Forget the fetched map, so the next `useArtMap` fetches again. */
export function __resetArtMapForTests(): void {
  pending = null;
}

/** The asset map; `{}` until it arrives and whenever it cannot be read. */
export function useArtMap(): ArtMap {
  const [map, setMap] = useState<ArtMap>({});
  useEffect(() => {
    let live = true;
    loadArtMap().then((m) => {
      if (live && Object.keys(m).length > 0) setMap(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return map;
}
