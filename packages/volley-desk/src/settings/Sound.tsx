/**
 * Settings › Sound: the theme picker (twelve cards, each with an audition
 * row that plays any event in that theme without switching to it), master
 * volume and Mute all, the per-event switches grouped as in `EVENT_GROUPS`
 * (each with a play button that auditions the current theme), and when
 * sounds play: only while the tab is hidden, quiet hours, reduced motion and
 * vibration (offered only where the browser can vibrate). Everything persists
 * through `useSoundSettings`; an audition ignores mute, quiet hours and the
 * hidden-tab rule (it is asked for) but keeps the master volume. Leaving the
 * section drops the auditioned themes.
 *
 * The section drills into groups (`GroupList`): Theme, Volume, Sounds (the
 * per-event cards) and When sounds play, one page each.
 */
import { PlayCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import ElasticSlider from "../rb/ElasticSlider/ElasticSlider";
import { EVENT_GROUPS, SOUND_EVENTS, SOUND_EVENT_IDS, type SoundEventId } from "../sounds/events";
import { type SoundChange, type SoundSettings, isHHMM } from "../sounds/settings";
import { THEMES, type ThemeId } from "../sounds/themes";
import { GroupList } from "./GroupNav";
import { Group, Row, Toggle } from "./primitives";
import { sectionDef } from "./sections";
import "../styles/settings.css";

export interface SoundSectionProps {
  sound: SoundSettings;
  setSound: (change: SoundChange) => void;
  /** Loads a theme; resolves once its clips are decoded. */
  loadTheme: (theme: ThemeId) => Promise<void>;
  audition: (theme: ThemeId, id: SoundEventId) => void | Promise<void>;
  disposeAudition: () => void;
  /** The browser can vibrate; the row is hidden otherwise. */
  canVibrate: boolean;
}

/** Settings › Sound's own props, besides the sound settings: which group page is open. */
export interface SoundNavProps {
  /** The open group's page (`theme`, `volume`, `events`, `when`), or null for the group list. */
  group: string | null;
  onOpenGroup?: (group: string) => void;
  /** The group a sidebar search hit. */
  hit?: string | undefined;
}

/** The group list's one-line summaries; `loading`: the picked theme is still loading. */
export function soundSummaries({
  sound,
  loading,
}: {
  sound: SoundSettings;
  loading: boolean;
}): Record<string, string> {
  const on = SOUND_EVENT_IDS.filter((id) => sound.events[id]).length;
  const q = sound.quietHours;
  return {
    theme: `${label(sound.theme)}${loading ? " · loading…" : ""}`,
    volume: sound.muted ? "muted" : `${Math.round(sound.volume * 100)}%`,
    events: `${on} of ${SOUND_EVENT_IDS.length} on`,
    when: q.on
      ? `quiet ${q.from}–${q.to}`
      : sound.signalsOnlyWhenHidden
        ? "only when hidden"
        : "always",
  };
}

const label = (theme: ThemeId) => THEMES.find((t) => t.id === theme)?.label ?? theme;

/** An `HH:MM` field committed on blur or Enter; an invalid entry falls back to the saved one. */
function TimeInput({
  id,
  value,
  onCommit,
  ariaLabel,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && isHHMM(draft) && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      id={id}
      className="look-num snd-time recessed mono"
      type="time"
      aria-label={ariaLabel}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

const PlayBtn = ({ name, onPlay }: { name: string; onPlay: () => void }) => (
  <button type="button" className="icon-btn snd-play" aria-label={name} onClick={onPlay}>
    <HugeiconsIcon icon={PlayCircleIcon} size={13} strokeWidth={1.8} />
  </button>
);

export function Sound({
  sound,
  setSound,
  loadTheme,
  audition,
  disposeAudition,
  canVibrate,
  group,
  onOpenGroup = () => {},
  hit,
}: SoundSectionProps & SoundNavProps) {
  const [loading, setLoading] = useState<ThemeId | null>(null);
  useEffect(() => () => disposeAudition(), [disposeAudition]);

  const pickTheme = (theme: ThemeId) => {
    if (theme === sound.theme) return;
    setSound({ theme });
    setLoading(theme);
    void loadTheme(theme).finally(() => setLoading((l) => (l === theme ? null : l)));
  };
  const q = sound.quietHours;

  if (group === "theme") {
    return (
      <Group foot="Each theme loads only when you pick it or play one of its sounds. Playing a sound here ignores mute and quiet hours.">
        <div className="s-pad snd-themes">
          {THEMES.map((t) => {
            const on = t.id === sound.theme;
            return (
              <div key={t.id} className={`snd-card${on ? " on" : ""}`}>
                <button
                  type="button"
                  className="snd-pick"
                  aria-pressed={on}
                  onClick={() => pickTheme(t.id)}
                >
                  <b>{t.label}</b>
                  <span className="s-hint">{t.brief}</span>
                  {loading === t.id && (
                    <progress className="snd-load" aria-label={`Loading ${t.label}`} />
                  )}
                </button>
                {/* biome-ignore lint/a11y/useSemanticElements: a row of buttons, not a form fieldset */}
                <div className="snd-chips" role="group" aria-label={`Audition ${t.label}`}>
                  {SOUND_EVENT_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="snd-chip"
                      aria-label={`Play ${SOUND_EVENTS[id].label} in ${t.label}`}
                      onClick={() => void audition(t.id, id)}
                    >
                      {SOUND_EVENTS[id].label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Group>
    );
  }
  if (group === "volume") {
    return (
      <Group>
        <Row label="Master volume">
          <div className="s-slider">
            <ElasticSlider
              value={Math.round(sound.volume * 100)}
              startingValue={0}
              maxValue={100}
              isStepped
              stepSize={5}
              valuePosition="none"
              leftIcon={null}
              rightIcon={null}
              rangeColor="#ff2d55"
              trackColor="rgba(255,255,255,.12)"
              ariaLabel="Master volume"
              onChange={(v) => setSound({ volume: Math.max(0, Math.min(1, v / 100)) })}
            />
            <span className="mono s-val">{Math.round(sound.volume * 100)}%</span>
          </div>
        </Row>
        <Row label="Mute all">
          <Toggle label="Mute all" on={sound.muted} onChange={(muted) => setSound({ muted })} />
        </Row>
      </Group>
    );
  }
  if (group === "events") {
    return (
      <>
        {EVENT_GROUPS.map(({ group, ids }) => (
          <Group key={group} title={group}>
            {ids.map((id) => {
              const e = SOUND_EVENTS[id];
              return (
                <Row key={id} label={e.label}>
                  <PlayBtn
                    name={`Play ${e.label} in the current theme (${label(sound.theme)})`}
                    onPlay={() => void audition(sound.theme, id)}
                  />
                  <Toggle
                    label={`${e.label} sound`}
                    on={sound.events[id]}
                    onChange={(v) => setSound({ events: { [id]: v } })}
                  />
                </Row>
              );
            })}
          </Group>
        ))}
      </>
    );
  }
  if (group !== "when") {
    return (
      <GroupList
        section={sectionDef("sound")}
        summaries={soundSummaries({ sound, loading: loading !== null })}
        onOpen={onOpenGroup}
        hit={hit}
      />
    );
  }
  return (
    <Group>
      <Row
        label="Only when the Desk tab is hidden"
        hint="Agent, pipeline, wave and system sounds; clicks never play in a hidden tab, and Needs you always plays"
      >
        <Toggle
          label="Only when the Desk tab is hidden"
          on={sound.signalsOnlyWhenHidden}
          onChange={(signalsOnlyWhenHidden) => setSound({ signalsOnlyWhenHidden })}
        />
      </Row>
      <Row label="Quiet hours" hint="Local time; a range past midnight wraps">
        <TimeInput
          id="snd-quiet-from"
          ariaLabel="Quiet hours from"
          value={q.from}
          onCommit={(from) => setSound({ quietHours: { from } })}
        />
        <span className="dim">to</span>
        <TimeInput
          id="snd-quiet-to"
          ariaLabel="Quiet hours to"
          value={q.to}
          onCommit={(to) => setSound({ quietHours: { to } })}
        />
        <Toggle label="Quiet hours" on={q.on} onChange={(on) => setSound({ quietHours: { on } })} />
      </Row>
      <Row label="Attention sounds too" hint="Off: Needs you still plays in quiet hours">
        <Toggle
          label="Attention sounds too"
          on={q.attentionToo}
          onChange={(attentionToo) => setSound({ quietHours: { attentionToo } })}
        />
      </Row>
      <Row
        label="Follow reduced motion"
        hint="When the system asks for reduced motion, play no sounds"
      >
        <Toggle
          label="Follow reduced motion"
          on={sound.followReducedMotion}
          onChange={(followReducedMotion) => setSound({ followReducedMotion })}
        />
      </Row>
      {canVibrate && (
        <Row label="Vibrate on attention" hint="On a phone, or while the tab is hidden">
          <Toggle
            label="Vibrate on attention"
            on={sound.vibrate}
            onChange={(vibrate) => setSound({ vibrate })}
          />
        </Row>
      )}
    </Group>
  );
}
