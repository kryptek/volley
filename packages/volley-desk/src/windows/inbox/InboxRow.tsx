/**
 * One Needs you row: a `SpotlightCard` with the source wave's colour bar (neutral for a session
 * in no wave), the kind, title, question and live line (`ShinyText`), then one `SpecularButton`
 * per option (`Other…` opens a text field when the item allows it) and the coordinators
 * window's go-to / Show / Dismiss. An owner-only release item is wrapped in a `StarBorder`.
 *
 * An answer is `inbox_answer { id, version, answer, where: { kind: "desk", device } }` through
 * the steer transport's `control()`; volleyd referees it. A refusal (`already answered on
 * <where>`) is shown and the row flips to answered; any other failure is shown and the buttons
 * stay. The store applies the retained update either way. Without broker credentials (no
 * `control`) an option shows the `volleyd inbox answer <id> "<answer>"` command to copy instead.
 * An answered row shows `StatusMark` with where it was answered.
 */
import { CenterFocusIcon, EyeIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import ShinyText from "../../rb/ShinyText/ShinyText";
import SpecularButton from "../../rb/SpecularButton/SpecularButton";
import SpotlightCard from "../../rb/SpotlightCard/SpotlightCard";
import StarBorder from "../../rb/StarBorder/StarBorder";
import StatusMark from "../../rb/StatusMark/StatusMark";
import { type SteerTransport, shellQuote } from "../../steer/transport";
import type { InboxItem, WaveView } from "../../store/types";
import { IconBtn } from "../wave/WaveWindow";
import { NEUTRAL_ACCENT, accentFor } from "../wave/accent";
import { ReleaseItem, type ReleaseItemProps } from "./ReleaseItem";
import { whereLabel } from "./inboxFilters";

const REFUSED_ANSWERED = /^already answered on (.+)$/;

/** The CLI fallback for a Desk without broker credentials (D4's copyable-command pattern). */
export function answerCommand(id: string, answer: string): string {
  return `volleyd inbox answer ${shellQuote(id)} ${shellQuote(answer)}`;
}

export interface InboxRowProps {
  item: InboxItem;
  /** Only a person answers it (`needsPerson`). */
  needsYou: boolean;
  live?: string | null | undefined;
  wave?: WaveView | undefined;
  control: SteerTransport["control"] | null;
  device: string;
  /** The record has cleared: the row is fading out. */
  leaving?: boolean;
  narrow?: boolean;
  release?: Pick<ReleaseItemProps, "origin" | "loadEvidence">;
  onGoTo?: (() => void) | undefined;
  onShow?: (() => void) | undefined;
  onDismiss: () => void;
}

type Sent =
  | { state: "idle" }
  | { state: "sending"; answer: string }
  | { state: "error"; error: string }
  | { state: "answered"; label: string };

export function InboxRow(p: InboxRowProps) {
  const { item } = p;
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const [other, setOther] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const accent = item.wave !== undefined ? accentFor(item.wave) : NEUTRAL_ACCENT;

  const send = async (answer: string) => {
    if (answer.trim() === "") return;
    if (!p.control) {
      setCommand(answerCommand(item.id, answer));
      return;
    }
    setSent({ state: "sending", answer });
    const r = await p.control(
      "inbox_answer",
      { id: item.id, version: item.version, answer, where: { kind: "desk", device: p.device } },
      answerCommand(item.id, answer),
    );
    if (r.ok) {
      setSent({ state: "answered", label: `answered on desk·${p.device} · ${answer}` });
      setOther(null);
      return;
    }
    const error = r.error ?? "volleyd refused the answer";
    setSent(
      REFUSED_ANSWERED.test(error)
        ? { state: "answered", label: error }
        : { state: "error", error },
    );
  };

  const answeredLabel = item.answered
    ? `answered on ${whereLabel(item.answered.where)} · ${item.answered.answer}`
    : sent.state === "answered"
      ? sent.label
      : null;
  const busy = sent.state === "sending";
  const btn = `inbox-target${p.narrow ? " inbox-target--phone" : ""}`;

  const answers: ReactNode =
    answeredLabel !== null ? (
      <StatusMark
        status="done"
        label={answeredLabel}
        size={16}
        fontSize={12}
        className="inbox-answered"
      />
    ) : (
      <>
        <fieldset className="inbox-options" aria-label="Answers">
          {(item.options ?? []).map((o, i) => (
            <SpecularButton
              key={`${i}:${o.label}`}
              size="sm"
              className={btn}
              disabled={busy}
              aria-label={o.label}
              title={o.description}
              onClick={() => void send(o.label)}
            >
              {o.label}
              {o.description && <span className="inbox-opt-desc"> · {o.description}</span>}
            </SpecularButton>
          ))}
          {item.allow_other && other === null && (
            <SpecularButton size="sm" className={btn} disabled={busy} onClick={() => setOther("")}>
              Other…
            </SpecularButton>
          )}
        </fieldset>
        {other !== null && (
          <form
            className="inbox-other"
            onSubmit={(e) => {
              e.preventDefault();
              void send(other);
            }}
          >
            <input
              className={`recessed ${btn}`}
              aria-label="Your answer"
              value={other}
              disabled={busy}
              onChange={(e) => setOther(e.target.value)}
            />
            <SpecularButton
              type="submit"
              size="sm"
              className={btn}
              disabled={busy || other.trim() === ""}
            >
              Send
            </SpecularButton>
          </form>
        )}
        {busy && <StatusMark status="running" label="Sending…" size={16} fontSize={12} />}
        {sent.state === "error" && (
          <p className="inbox-error" role="alert">
            {sent.error}
          </p>
        )}
        {command !== null && (
          <div className="inbox-cmd">
            <code className="mono">{command}</code>
            <button
              type="button"
              className={`coord-btn ${btn}`}
              onClick={() => void navigator.clipboard?.writeText(command).catch(() => {})}
            >
              Copy command
            </button>
          </div>
        )}
      </>
    );

  const where = [item.wave, item.task].filter(Boolean).join("/") || item.agent_id;
  const card = (
    <SpotlightCard className="inbox-card" spotlightColor={`${accent}33`}>
      <span className="inbox-bar" style={{ background: accent }} />
      <div className="inbox-main">
        <div className="inbox-head">
          <span className={`chip inbox-kind inbox-kind--${item.kind}`}>{item.kind}</span>
          {item.owner_only && <span className="chip chip--hot">owner only</span>}
          {p.needsYou && !item.owner_only && <span className="chip chip--hot">needs you</span>}
          <span className="inbox-title">{item.title}</span>
        </div>
        <div className="inbox-sub dim">{where}</div>
        <p className="inbox-question">{item.question}</p>
        {p.live && (
          <div className="inbox-live">
            <ShinyText text={p.live} speed={3} />
          </div>
        )}
        {item.kind === "release" && <ReleaseItem item={item} wave={p.wave} {...p.release} />}
        {answers}
      </div>
      <div className="coord-actions inbox-actions">
        {p.onGoTo && <IconBtn label={`Go to ${where}`} i={CenterFocusIcon} onClick={p.onGoTo} />}
        {p.onShow && <IconBtn label={`Show ${where}`} i={EyeIcon} onClick={p.onShow} />}
        <IconBtn label={`Dismiss ${item.title}`} i={ViewOffIcon} onClick={p.onDismiss} />
      </div>
    </SpotlightCard>
  );
  return (
    <li
      aria-label={`Inbox item ${item.id}: ${item.title}`}
      className={`inbox-row inbox-row--${item.kind}${answeredLabel !== null ? " inbox-row--answered" : ""}${p.leaving ? " inbox-row--leaving" : ""}`}
    >
      {item.owner_only && item.kind === "release" ? (
        // A div, not StarBorder's default <button>: the row holds buttons of its own.
        <StarBorder as="div" className="inbox-star" color="#ff7a59" duration={5} thickness={2}>
          {card}
        </StarBorder>
      ) : (
        card
      )}
    </li>
  );
}
