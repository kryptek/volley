/**
 * Settings › General: the canvas (auto-arrange with "Arrange & fit now",
 * finished agents shown or hidden and the grace before they leave), the
 * notifications (the sound and the browser notifications, the same settings
 * as the top bar's toggles) and the agent windows' narration effect. The
 * look's keys persist through `useLook`, the notification ones through
 * `useNotifySettings`.
 */
import { useState } from "react";
import { NARR_LABEL } from "../look/options";
import { FINISHED_GRACE_MAX_MIN, type Look, isGraceMin } from "../look/useLook";
import { requestNotificationPermission } from "../notify/notify-permission";
import type { NotifyOptions } from "../notify/use-notify-settings";
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
      className="look-num mono"
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

const blockedNow = () =>
  typeof Notification !== "undefined" && Notification.permission === "denied";

export function General({
  look,
  setLook,
  notify,
  setNotify,
  onArrange,
}: {
  look: Look;
  setLook: (change: Partial<Look>) => void;
  notify: NotifyOptions;
  setNotify: (next: NotifyOptions) => void;
  onArrange: () => void;
}) {
  const [blocked, setBlocked] = useState(blockedNow);
  const toggleNotify = (on: boolean) => {
    if (!on) return setNotify({ ...notify, enabled: false });
    void requestNotificationPermission().then((result) => {
      // Only a refusal is "blocked"; dismissing the prompt leaves it askable.
      setBlocked(result === "denied");
      setNotify({ ...notify, enabled: result === "granted" });
    });
  };
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
            onChange={(sound) => setNotify({ ...notify, sound })}
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
