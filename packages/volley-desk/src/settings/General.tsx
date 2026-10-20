/**
 * Settings › General: the canvas (auto-arrange with "Arrange & fit now", the
 * window layout's Reset layout, which clears every window pin (C12),
 * finished agents shown or hidden and the grace before they leave), the
 * notifications (the sound and the browser notifications, the same settings
 * as the top bar's toggles) and the agent windows' narration effect. The
 * look's keys persist through `useLook`, the notification ones through
 * `useNotifySettings` (sound is `notify.sound` in `volley-dash:notify`, shared
 * with the top bar, not a look key); the switch is `useNotifyToggle`.
 */
import { useState } from "react";
import { NARR_LABEL } from "../look/options";
import { FINISHED_GRACE_MAX_MIN, type Look, isGraceMin } from "../look/useLook";
import type { NotifyOptions, SetNotify } from "../notify/use-notify-settings";
import { useNotifyToggle } from "../notify/use-notify-toggle";
import { Group, Row, Seg, Toggle } from "./primitives";
import "../styles/look.css";

/**
 * The finished-agent grace in minutes. Typing edits a draft, committed on blur
 * or Enter, so backspacing `10` towards `45` never applies (and saves) `1` on
 * the way; an empty or invalid draft is dropped for the saved value.
 */
function GraceInput({ value, onCommit }: { value: number; onCommit: (min: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== "" && isGraceMin(v) && v !== value) onCommit(v);
    setDraft(null);
  };
  return (
    <input
      id="look-finished-grace"
      className="look-num recessed mono"
      type="number"
      min={0}
      max={FINISHED_GRACE_MAX_MIN}
      step={1}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

export function General({
  look,
  setLook,
  notify,
  setNotify,
  onArrange,
  onResetLayout,
}: {
  look: Look;
  setLook: (change: Partial<Look>) => void;
  notify: NotifyOptions;
  setNotify: SetNotify;
  onArrange: () => void;
  /** Clear every window pin (pinned in place, anchored to the screen) in this browser (the desktop and phone layouts both). */
  onResetLayout?: () => void;
}) {
  const { toggle: toggleNotify, blocked } = useNotifyToggle(setNotify);
  return (
    <>
      <Group title="Canvas">
        <Row label="Auto-arrange" hint="Re-arrange and fit when windows open, close, hide or show">
          <button type="button" className="btn btn--sm" onClick={onArrange}>
            Arrange &amp; fit now
          </button>
          <Toggle
            label="Auto-arrange"
            on={look.autoArrange}
            onChange={(autoArrange) => setLook({ autoArrange })}
          />
        </Row>
        {onResetLayout && (
          <Row
            label="Window layout"
            hint="Unpin every window pinned in place or anchored to the screen, then arrange"
          >
            <button type="button" className="btn btn--sm" onClick={onResetLayout}>
              Reset layout
            </button>
          </Row>
        )}
        <Row
          label="Show finished agents"
          hint={`Agents that are done, failed or gone for more than ${look.finishedGraceMin} min`}
        >
          <Toggle
            label="Show finished agents"
            on={look.showFinished}
            onChange={(showFinished) => setLook({ showFinished })}
          />
        </Row>
        <Row
          label="Hide finished agents after (minutes)"
          hint="While finished agents are hidden"
          htmlFor="look-finished-grace"
        >
          <GraceInput
            value={look.finishedGraceMin}
            onCommit={(finishedGraceMin) => setLook({ finishedGraceMin })}
          />
        </Row>
      </Group>
      <Group title="Notifications">
        <Row label="Sound when something needs you">
          <Toggle
            label="Sound when something needs you"
            on={notify.sound}
            onChange={(sound) => setNotify((prev) => ({ ...prev, sound }))}
          />
        </Row>
        <Row
          label="Browser notifications"
          hint={
            notify.enabled
              ? "On · allowed in this browser"
              : blocked
                ? "Blocked in this browser · allow notifications in its site settings"
                : "Off"
          }
        >
          <Toggle label="Browser notifications" on={notify.enabled} onChange={toggleNotify} />
        </Row>
      </Group>
      <Group title="Agent windows">
        <Row label="Narration effect">
          <Seg
            label="Narration effect"
            options={NARR_LABEL}
            value={look.narr}
            onPick={(narr) => setLook({ narr })}
          />
        </Row>
      </Group>
    </>
  );
}
