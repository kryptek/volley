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
 *
 * A decision's row also offers **Hold · waiting on…** (SPEC §4.6.2): a picker of the wave's
 * other unsettled tasks and their open PRs; picking one sends `hold { item, on }` (without
 * credentials, the `volleyd inbox hold` command to copy). A held row shows the amber
 * `Held · waiting on T4 (#194) · 3 h` line and a Release button (`release { item }`); its
 * options still answer it.
 *
 * A handoff volleyd cannot type into its session's screen (the screen is another session's, or
 * volleyd cannot see it) offers **Send to mailbox**: the same answer as a mailbox message to the
 * session, which reads it at its next turn.
 *
 * A group of identical decisions (`inboxGroups.ts`, #417) is one row for its `members`: a `×N`
 * chip, an `N tasks waiting · …` line, and every answer, hold or release fans out to each member
 * in turn (each its own `inbox_answer` with its own version). A member answered elsewhere is
 * counted as answered; any other failure shows `answered 8 of 11 · retry the rest` and the
 * buttons stay, a retry going to the rest only.
 */
import { CenterFocusIcon, EyeIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { heldReason } from "../../attention";
import { plural } from "../../lib/plural";
import ShinyText from "../../rb/ShinyText/ShinyText";
import SpecularButton from "../../rb/SpecularButton/SpecularButton";
import SpotlightCard from "../../rb/SpotlightCard/SpotlightCard";
import StarBorder from "../../rb/StarBorder/StarBorder";
import StatusMark from "../../rb/StatusMark/StatusMark";
import { type SteerTransport, shellQuote } from "../../steer/transport";
import type { HeldOn, InboxItem, WaveView } from "../../store/types";
import { IconBtn } from "../wave/WaveWindow";
import { NEUTRAL_ACCENT, accentFor } from "../wave/accent";
import { ReleaseItem, type ReleaseItemProps } from "./ReleaseItem";
import { whereLabel } from "./inboxFilters";

const REFUSED_ANSWERED = /^already answered on (.+)$/;
/** volleyd could not reach the session's screen: another session's, or one it cannot see. */
const REFUSED_SCREEN = /'s screen/;

/** The CLI fallback for a Desk without broker credentials (D4's copyable-command pattern). */
export function answerCommand(id: string, answer: string): string {
  return `volleyd inbox answer ${shellQuote(id)} ${shellQuote(answer)}`;
}

/** The CLI fallback for a hold without broker credentials. */
export function holdCommand(id: string, on: HeldOn): string {
  const target =
    on.task !== undefined ? on.task : on.pr !== undefined ? `#${on.pr}` : `issue#${on.issue}`;
  return `volleyd inbox hold ${shellQuote(id)} --on ${shellQuote(target)}`;
}

/**
 * What a decision can be held on: the wave's other unsettled tasks, then their PRs. A group's
 * `members` are all left out.
 */
export function holdChoices(
  item: InboxItem,
  wave: WaveView | undefined,
  members: readonly InboxItem[] = [item],
): { key: string; label: string; on: HeldOn }[] {
  const own = new Set(members.map((m) => m.task));
  const tasks = (wave?.state?.tasks ?? []).filter(
    (t) => !own.has(t.id) && t.stage !== "done" && t.stage !== "cancelled",
  );
  return [
    ...tasks.map((t) => ({
      key: `task:${t.id}`,
      label: t.pr ? `${t.id} (#${t.pr.number})` : t.id,
      on: { task: t.id },
    })),
    ...tasks.flatMap((t) =>
      t.pr
        ? [{ key: `pr:${t.pr.number}`, label: `PR #${t.pr.number}`, on: { pr: t.pr.number } }]
        : [],
    ),
  ];
}

/** A group's line: `11 tasks waiting · i392, i416, i401 +8`. */
function waiting(members: readonly InboxItem[]): string {
  const names = members.map((m) => m.task ?? m.agent_id);
  const more = names.length > 3 ? ` +${names.length - 3}` : "";
  return `${plural(members.length, "task")} waiting · ${names.slice(0, 3).join(", ")}${more}`;
}

export interface InboxRowProps {
  item: InboxItem;
  /** A group's items, oldest first (`item` is the first); absent: the item alone. */
  members?: readonly InboxItem[];
  /** Only a person answers it (`needsPerson`). */
  needsYou: boolean;
  live?: string | null | undefined;
  wave?: WaveView | undefined;
  control: SteerTransport["control"] | null;
  device: string;
  /** Now (ms), for the held line's age (default: the clock). */
  now?: number;
  /** The record has cleared: the row is fading out. */
  leaving?: boolean;
  narrow?: boolean;
  release?: Pick<ReleaseItemProps, "origin" | "loadEvidence">;
  onGoTo?: (() => void) | undefined;
  onShow?: (() => void) | undefined;
  onDismiss: () => void;
  /** Deliver `text` to the item's session as a mailbox message; null without credentials. */
  mailbox?: ((text: string) => void) | null | undefined;
}

type Sent =
  | { state: "idle" }
  | { state: "sending"; answer: string }
  | { state: "error"; error: string; answer: string }
  | { state: "answered"; label: string };

export function InboxRow(p: InboxRowProps) {
  const { item } = p;
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const [other, setOther] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const accent = item.wave !== undefined ? accentFor(item.wave) : NEUTRAL_ACCENT;
  const members = p.members ?? [item];
  const n = members.length;
  /** A group's members answered so far (here or elsewhere): a retry skips them. */
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());

  const sendAll = async (control: SteerTransport["control"], answer: string) => {
    const answered = new Set(done);
    let error: string | null = null;
    for (const m of members) {
      if (answered.has(m.id)) continue;
      const r = await control(
        "inbox_answer",
        { id: m.id, version: m.version, answer, where: { kind: "desk", device: p.device } },
        answerCommand(m.id, answer),
      );
      if (r.ok || REFUSED_ANSWERED.test(r.error ?? "")) answered.add(m.id);
      else error ??= r.error ?? "volleyd refused the answer";
    }
    setDone(answered);
    if (error === null) {
      setSent({ state: "answered", label: `answered ${n} on desk·${p.device} · ${answer}` });
      setOther(null);
      return;
    }
    setSent({
      state: "error",
      error: `answered ${answered.size} of ${n} · retry the rest: ${error}`,
      answer,
    });
  };

  const send = async (answer: string) => {
    if (answer.trim() === "") return;
    if (!p.control) {
      setCommand(members.map((m) => answerCommand(m.id, answer)).join("\n"));
      return;
    }
    setSent({ state: "sending", answer });
    if (n > 1) return sendAll(p.control, answer);
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
        : { state: "error", error, answer },
    );
  };

  const toMailbox =
    sent.state === "error" &&
    item.kind === "handoff" &&
    p.mailbox &&
    REFUSED_SCREEN.test(sent.error)
      ? { mailbox: p.mailbox, answer: sent.answer }
      : null;

  /** `hold { item, on }` or `release { item }` through volleyd; the retained item follows. */
  const holdOp = async (op: "hold" | "release", on?: HeldOn): Promise<boolean> => {
    setHoldError(null);
    const cli = (m: InboxItem) =>
      on !== undefined
        ? holdCommand(m.id, on)
        : `volleyd release ${shellQuote(String(m.source.decision_id ?? m.id))}`;
    if (!p.control) {
      setCommand(members.map(cli).join("\n"));
      setPicking(false);
      return true;
    }
    setHoldBusy(true);
    let error: string | null = null;
    for (const m of members) {
      const r = await p.control(op, { item: m.id, ...(on !== undefined ? { on } : {}) }, cli(m));
      if (!r.ok) error ??= r.error ?? `volleyd refused the ${op}`;
    }
    setHoldBusy(false);
    if (error === null) setPicking(false);
    else setHoldError(error);
    return error === null;
  };
  const choices = item.kind === "decision" ? holdChoices(item, p.wave, members) : [];

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
        {item.kind === "decision" &&
          (item.held ? (
            <div className="inbox-held-actions">
              <button
                type="button"
                className={`coord-btn ${btn}`}
                disabled={holdBusy}
                onClick={() => void holdOp("release")}
              >
                Release
              </button>
            </div>
          ) : picking ? (
            <label className="inbox-hold">
              <span className="dim">Hold · waiting on</span>
              <select
                className={`recessed ${btn}`}
                aria-label="Hold · waiting on"
                disabled={holdBusy}
                defaultValue=""
                onChange={(e) => {
                  const select = e.currentTarget;
                  const c = choices.find((x) => x.key === select.value);
                  // A refused hold resets the picker so the same choice can be retried.
                  if (c)
                    void holdOp("hold", c.on).then((ok) => {
                      if (!ok) select.value = "";
                    });
                }}
              >
                <option value="" disabled>
                  {choices.length === 0 ? "nothing to wait on" : "a task or PR…"}
                </option>
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`coord-btn ${btn}`}
                onClick={() => setPicking(false)}
              >
                Cancel
              </button>
            </label>
          ) : (
            choices.length > 0 && (
              <button type="button" className={`coord-btn ${btn}`} onClick={() => setPicking(true)}>
                Hold · waiting on…
              </button>
            )
          ))}
        {holdError !== null && (
          <p className="inbox-error" role="alert">
            {holdError}
          </p>
        )}
        {busy && <StatusMark status="running" label="Sending…" size={16} fontSize={12} />}
        {sent.state === "error" && (
          <p className="inbox-error" role="alert">
            {sent.error}
          </p>
        )}
        {toMailbox !== null && (
          <button
            type="button"
            className={`coord-btn ${btn}`}
            onClick={() => {
              toMailbox.mailbox(toMailbox.answer);
              setOther(null);
              setSent({
                state: "answered",
                label: `sent to ${item.agent_id}'s mailbox · ${toMailbox.answer}`,
              });
            }}
          >
            Send to mailbox
          </button>
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

  // A group's tasks are on its waiting line.
  const where =
    [item.wave, n > 1 ? undefined : item.task].filter(Boolean).join("/") || item.agent_id;
  const card = (
    <SpotlightCard className="inbox-card" spotlightColor={`${accent}33`}>
      <span className="inbox-bar" style={{ background: accent }} />
      <div className="inbox-main">
        <div className="inbox-head">
          <span className={`chip inbox-kind inbox-kind--${item.kind}`}>{item.kind}</span>
          {item.owner_only && <span className="chip chip--hot">owner only</span>}
          {p.needsYou && !item.owner_only && <span className="chip chip--hot">needs you</span>}
          {item.held && item.answered === undefined && (
            <span className="chip inbox-held-chip">held</span>
          )}
          {n > 1 && <span className="chip inbox-count">×{n}</span>}
          <span className="inbox-title">{item.title}</span>
        </div>
        <div className="inbox-sub dim">{where}</div>
        {n > 1 && <div className="inbox-waiting dim">{waiting(members)}</div>}
        <p className="inbox-question">{item.question}</p>
        {item.held && answeredLabel === null && (
          <div className="attn-line attn-coordinator inbox-held">
            {heldReason(item.held, p.wave, p.now ?? Date.now())}
            {item.held.note ? ` · ${item.held.note}` : ""}
          </div>
        )}
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
      className={`inbox-row inbox-row--${item.kind}${item.held && answeredLabel === null ? " inbox-row--held" : ""}${answeredLabel !== null ? " inbox-row--answered" : ""}${p.leaving ? " inbox-row--leaving" : ""}`}
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
