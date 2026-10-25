/** The Getting started wizard's steps, one scene each (G1's step ids are the same strings). */
export const SCENE_IDS = [
  "welcome",
  "this-computer",
  "machines",
  "repos",
  "people",
  "access",
  "done",
] as const;

export type SceneId = (typeof SCENE_IDS)[number];

/** Each scene's alt text: the `aria-label` and `<title>` of its svg, the `alt` of its raster. */
export const SCENE_ALT: Record<SceneId, string> = {
  welcome: "Three otters tossing a volleyball between them",
  "this-computer": "An otter in a hard hat holding a wrench",
  machines: "An otter plugging a cable into a laptop",
  repos: "An otter in a cap carrying a box labelled repo",
  people: "Two otters, one wearing a crown and one wearing a badge",
  access: "An otter in a headset holding a globe, a phone beside it",
  done: "Three otters celebrating in party hats with a flag and confetti",
};

export const isSceneId = (s: string): s is SceneId => (SCENE_IDS as readonly string[]).includes(s);
