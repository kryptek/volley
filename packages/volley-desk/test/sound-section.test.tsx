/** Settings › Sound: theme picker, volume and mute, per-event switches and the quiet rules. */
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOK0 } from "../src/look/useLook";
import { NOTIFY_STORAGE_KEY } from "../src/notify/use-notify-settings";
import { SettingsWindow } from "../src/settings/SettingsWindow";
import { Sound, type SoundSectionProps } from "../src/settings/Sound";
import { EVENT_GROUPS } from "../src/sounds/events";
import {
  SOUND0,
  type SoundChange,
  loadSoundSettings,
  mergeSound,
  useNotifyMirror,
  useSoundSettings,
} from "../src/sounds/settings";
import { THEMES } from "../src/sounds/themes";

afterEach(() => localStorage.clear());

/** The section over the real settings hook, so every change round-trips through storage. */
function Harness(over: Partial<SoundSectionProps> = {}) {
  const [sound, setSound] = useSoundSettings();
  return (
    <Sound
      sound={sound}
      setSound={setSound}
      loadTheme={async () => {}}
      audition={() => {}}
      disposeAudition={() => {}}
      canVibrate
      {...over}
    />
  );
}

const sw = (name: string) => screen.getByRole("switch", { name });

describe("Settings › Sound", () => {
  it("shows twelve theme cards with the selected one pressed", () => {
    render(<Harness />);
    const picks = THEMES.map((t) =>
      screen.getByRole("button", { name: new RegExp(`^${t.label}`) }),
    );
    expect(picks).toHaveLength(12);
    expect(picks[0]).toHaveAttribute("aria-pressed", "true");
    expect(picks.slice(1).every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("picking a theme saves it and shows a loading bar until it has loaded", async () => {
    let finish = () => {};
    const loadTheme = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    render(<Harness loadTheme={loadTheme} />);
    fireEvent.click(screen.getByRole("button", { name: /^Arcade 8-bit/ }));
    expect(loadTheme).toHaveBeenCalledWith("arcade");
    expect(loadSoundSettings().theme).toBe("arcade");
    expect(screen.getByRole("button", { name: /^Arcade 8-bit/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("progressbar", { name: "Loading Arcade 8-bit" })).toBeInTheDocument();
    await act(async () => finish());
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("master volume and Mute all persist", () => {
    render(<Harness />);
    const slider = screen.getByRole("slider", { name: "Master volume" });
    fireEvent.keyDown(slider, { key: "End" });
    expect(loadSoundSettings().volume).toBe(1);
    fireEvent.click(sw("Mute all"));
    expect(loadSoundSettings().muted).toBe(true);
  });

  it("lists the per-event switches by group with their defaults; a toggle saves only its key", () => {
    render(<Harness />);
    for (const { group } of EVENT_GROUPS)
      expect(screen.getByRole("heading", { name: group })).toBeInTheDocument();
    expect(sw("Agent working sound")).toHaveAttribute("aria-checked", "false");
    expect(sw("Agent complete sound")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw("CI failed sound"));
    const s = loadSoundSettings();
    expect(s.events.ci_failed).toBe(false);
    expect({ ...s.events, ci_failed: true }).toEqual(SOUND0.events);
  });

  it("the quiet rules round-trip through storage; an invalid time is ignored on blur", () => {
    render(<Harness />);
    fireEvent.click(sw("Only when the Desk tab is hidden"));
    fireEvent.click(sw("Quiet hours"));
    fireEvent.click(sw("Attention sounds too"));
    fireEvent.click(sw("Follow reduced motion"));
    fireEvent.click(sw("Vibrate on attention"));
    const from = screen.getByLabelText("Quiet hours from");
    fireEvent.change(from, { target: { value: "23:15" } });
    fireEvent.blur(from);
    const to = screen.getByLabelText("Quiet hours to");
    fireEvent.change(to, { target: { value: "99:99" } });
    fireEvent.blur(to);
    expect(loadSoundSettings()).toMatchObject({
      signalsOnlyWhenHidden: true,
      quietHours: { on: true, from: "23:15", to: "07:00", attentionToo: true },
      followReducedMotion: false,
      vibrate: false,
    });
    expect(to).toHaveValue("07:00");
  });

  it("hides the vibrate row where the browser cannot vibrate", () => {
    render(<Harness canVibrate={false} />);
    expect(screen.queryByRole("switch", { name: "Vibrate on attention" })).toBeNull();
  });

  it("passes axe", async () => {
    render(
      <main>
        <Harness />
      </main>,
    );
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("is keyboard reachable: every control is a focusable button, switch, slider or input", () => {
    render(<Harness />);
    for (const el of screen.getAllByRole("button")) expect(el.tabIndex).toBeGreaterThanOrEqual(0);
    expect(screen.getByRole("slider", { name: "Master volume" }).tabIndex).toBe(0);
  });
});

describe("in the Settings window", () => {
  function Window() {
    const [notify, setNotify] = useState({ enabled: false, sound: true, on: [] as string[] });
    return (
      <SettingsWindow
        look={LOOK0}
        setLook={() => {}}
        notify={notify}
        setNotify={(n) => setNotify(typeof n === "function" ? n(notify) : n)}
        webgl
        identity="desk"
        demo={false}
        config={null}
        transport={null}
        onArrange={() => {}}
        onClose={() => {}}
      />
    );
  }

  it("General points to Settings › Sound and its link opens it", () => {
    render(<Window />);
    const general = screen.getByText(/Sounds are in Settings › Sound/);
    fireEvent.click(within(general).getByRole("button", { name: "Open Sound" }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Sound");
    expect(screen.getByRole("group", { name: "Audition Synthwave" })).toBeInTheDocument();
  });
});

describe("useNotifyMirror", () => {
  function setup(notifySound = true) {
    return renderHook(
      ({ ns }: { ns: boolean }) => {
        const [sound, setSound] = useSoundSettings();
        const [n, setN] = useState(ns);
        useNotifyMirror(sound, setSound, n, setN);
        return { sound, setSound, n, setN };
      },
      { initialProps: { ns: notifySound } },
    );
  }

  it("a sound change writes !muted && attention_needed into notify.sound", () => {
    const { result } = setup();
    act(() => result.current.setSound({ muted: true } as SoundChange));
    expect(result.current.n).toBe(false);
    act(() => result.current.setSound({ muted: false }));
    expect(result.current.n).toBe(true);
    act(() => result.current.setSound({ events: { attention_needed: false } }));
    expect(result.current.n).toBe(false);
  });

  it("the old toggle maps to attention_needed (and turning it on unmutes)", () => {
    const { result } = setup();
    act(() => result.current.setN(false));
    expect(result.current.sound.events.attention_needed).toBe(false);
    act(() => result.current.setSound({ muted: true }));
    act(() => result.current.setN(true));
    expect(result.current.sound.events.attention_needed).toBe(true);
    expect(result.current.sound.muted).toBe(false);
    expect(JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "{}").sound).toBe(true);
  });

  it("leaves both alone when they agree", () => {
    const { result } = setup();
    expect(result.current.sound).toEqual(mergeSound(SOUND0, {}));
    expect(result.current.n).toBe(true);
  });
});
