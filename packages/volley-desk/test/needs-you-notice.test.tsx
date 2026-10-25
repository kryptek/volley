import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ctxFrom, inboxAttention } from "../src/attention";
import { initialState } from "../src/store/reducer";
import type { InboxItem } from "../src/store/types";
import { InboxRow } from "../src/windows/inbox/InboxRow";
import { matchesFilter } from "../src/windows/inbox/inboxFilters";

const LINK = "https://claude.ai/code/session_fake01";

const notice = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: "n-coordinator-link",
  kind: "notice",
  version: 1,
  owner_only: true,
  agent_id: "volleyd",
  title: "Coordinator on box-a: open it",
  question: LINK,
  pointers: { link: LINK },
  opened_at: "2026-10-25T12:00:00.000Z",
  source: { notice: "coordinator-link", machine: "box-a", name: "coord-test" },
  ...over,
});

function row(item: InboxItem, control = vi.fn(async () => ({ ok: true }))) {
  render(
    <ul>
      <InboxRow item={item} needsYou control={control} device="phone" onDismiss={() => {}} />
    </ul>,
  );
  return control;
}

describe("a notice in Needs you", () => {
  it("renders Open as a link to the item's link", () => {
    row(notice());
    const a = screen.getByRole("link", { name: "Open" });
    expect(a).toHaveAttribute("href", LINK);
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("Dismiss answers it", async () => {
    const control = row(notice());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith(
        "inbox_answer",
        {
          id: "n-coordinator-link",
          version: 1,
          answer: "dismiss",
          where: { kind: "desk", device: "phone" },
        },
        expect.any(String),
      ),
    );
  });

  it("Open also acknowledges it (answer open)", async () => {
    const control = row(notice());
    fireEvent.click(screen.getByRole("link", { name: "Open" }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith(
        "inbox_answer",
        expect.objectContaining({ id: "n-coordinator-link", answer: "open" }),
        expect.any(String),
      ),
    );
  });

  it("a second Open while the first is in flight sends nothing more", async () => {
    let finish: (v: { ok: boolean }) => void = () => {};
    const control = row(
      notice(),
      vi.fn(
        () =>
          new Promise<{ ok: boolean }>((r) => {
            finish = r;
          }),
      ),
    );
    const a = screen.getByRole("link", { name: "Open" });
    fireEvent.click(a);
    await waitFor(() => expect(a).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(a);
    expect(control).toHaveBeenCalledTimes(1);
    finish({ ok: true });
  });

  it("a failure notice has no link: Dismiss only", () => {
    row(
      notice({
        id: "n-coordinator-failed",
        title: "Coordinator on box-a stopped",
        question: "claude exited 1",
        pointers: {},
      }),
    );
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("needs a person while open (owner-only) and shows under the you filter", () => {
    const state = initialState();
    const tier = inboxAttention(notice(), state, ctxFrom(state, { now: Date.now() })).tier;
    expect(matchesFilter(notice(), "you", tier)).toBe(true);
  });
});
