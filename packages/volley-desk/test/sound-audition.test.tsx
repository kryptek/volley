/** Settings › Sound's audition rows: any event of any theme, from a side cache, without switching. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sound } from "../src/settings/Sound";
import { SOUND_EVENTS, SOUND_EVENT_IDS } from "../src/sounds/events";
import { createPlayer } from "../src/sounds/player";
import { SOUND0, type SoundSettings } from "../src/sounds/settings";
import {
  type FakeAudio,
  type FakeFetch,
  installFakeAudio,
  installFetch,
  themeRoutes,
} from "./helpers/fake-audio";

let audio: FakeAudio;
let net: FakeFetch;

beforeEach(() => {
  audio = installFakeAudio();
  net = installFetch({
    ...themeRoutes("synthwave", SOUND_EVENT_IDS),
    ...themeRoutes("arcade", SOUND_EVENT_IDS),
  });
});
afterEach(() => {
  audio.restore();
  net.restore();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(sound: SoundSettings = SOUND0, group = "theme") {
  const player = createPlayer({ baseUrl: "/sounds" });
  const setSound = vi.fn();
  const view = render(
    <Sound
      sound={sound}
      setSound={setSound}
      loadTheme={(t) => player.loadTheme(t)}
      audition={(t, id) => player.audition(t, id)}
      disposeAudition={() => player.disposeAudition()}
      canVibrate={false}
      group={group}
    />,
  );
  return { player, setSound, ...view };
}

describe("audition rows", () => {
  it("each theme card has a row of 28 chips named for the event and theme", () => {
    setup();
    const row = screen.getByRole("group", { name: "Audition Arcade 8-bit" });
    const chips = within(row).getAllByRole("button");
    expect(chips).toHaveLength(28);
    expect(chips[0]).toHaveAccessibleName(`Play ${SOUND_EVENTS.ui_click.label} in Arcade 8-bit`);
  });

  it("a chip of another theme loads it once into the side cache and plays it; the theme stays", async () => {
    const { player, setSound } = setup();
    await player.loadTheme("synthwave");
    const chip = screen.getByRole("button", { name: "Play Agent complete in Arcade 8-bit" });
    fireEvent.click(chip);
    await flush();
    await flush();
    fireEvent.click(chip);
    await flush();
    await flush();
    expect(net.calls.filter((u) => u === "/sounds/arcade/manifest.json")).toHaveLength(1);
    const ctx = audio.contexts[0];
    expect(ctx?.sources.map((s) => s.buffer)).toEqual([
      { decoded: "arcade/agent_complete" },
      { decoded: "arcade/agent_complete" },
    ]);
    expect(player.theme()).toBe("synthwave");
    expect(setSound).not.toHaveBeenCalled();
  });

  it("an audition ignores mute and quiet hours but keeps the master volume", async () => {
    const { player } = setup({
      ...SOUND0,
      muted: true,
      quietHours: { ...SOUND0.quietHours, on: true },
    });
    await player.loadTheme("synthwave");
    player.setVolume(0.4);
    fireEvent.click(screen.getByRole("button", { name: "Play Click in Synthwave" }));
    await flush();
    await flush();
    const ctx = audio.contexts[0];
    expect(ctx?.sources).toHaveLength(1);
    expect(ctx?.gains[0]?.gain.value).toBe(0.4);
  });

  it("a per-event row's play button auditions the selected theme", async () => {
    const { player } = setup({ ...SOUND0, theme: "arcade" }, "events");
    await player.loadTheme("arcade");
    fireEvent.click(
      screen.getByRole("button", { name: "Play CI failed in the current theme (Arcade 8-bit)" }),
    );
    await flush();
    await flush();
    expect(audio.contexts[0]?.sources[0]?.buffer).toEqual({ decoded: "arcade/ci_failed" });
  });

  it("leaving the section drops the auditioned themes (at most two decoded at once)", async () => {
    const { player, unmount } = setup();
    await player.loadTheme("synthwave");
    fireEvent.click(screen.getByRole("button", { name: "Play Click in Arcade 8-bit" }));
    await flush();
    await flush();
    expect(player.has("arcade")).toBe(true);
    unmount();
    expect(player.has("arcade")).toBe(false);
    expect(player.has("synthwave")).toBe(true);
  });
});
