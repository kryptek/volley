import { describe, expect, it } from "vitest";
import { INBOX_CHANNEL, type InboxItem, itemForNotice } from "../src/autopilot/inbox";
import { NOTICE_FAILED, NOTICE_LINK, noticesFor } from "../src/coordinator/notices";
import type { CoordinatorRolePayload } from "../src/coordinator/role";
import { envelope, schemaErrors } from "./helpers/schema";

const LINK = "https://claude.ai/code/session_01FAKEFAKEFAKEFAKEFAKE0000";
const LINK2 = "https://claude.ai/code/session_01FAKEFAKEFAKEFAKEFAKE0001";
const AT = "2026-10-25T12:00:00.000Z";

const running = (p: Partial<CoordinatorRolePayload> = {}): CoordinatorRolePayload => ({
  machine: "box-a",
  name: "coord-test",
  state: "running",
  since: AT,
  session_url: LINK,
  restarts: 0,
  dir: "/path/to/home/.volley/coordinator",
  ...p,
});

const openItem = (id: string, link?: string): InboxItem => ({
  id,
  kind: "notice",
  version: 1,
  owner_only: true,
  agent_id: "volleyd",
  title: "t",
  question: "q",
  pointers: link !== undefined ? { link } : {},
  opened_at: AT,
  source: {},
});

describe("noticesFor (SPEC §4.6.25)", () => {
  it("a new link opens n-coordinator-link with the link, superseding the open notices", () => {
    expect(noticesFor(null, running())).toEqual({
      supersede: [NOTICE_LINK, NOTICE_FAILED],
      open: [
        {
          notice: "coordinator-link",
          machine: "box-a",
          name: "coord-test",
          title: "Coordinator on box-a: open it",
          question: LINK,
          link: LINK,
        },
      ],
    });
    const changed = noticesFor(running(), running({ session_url: LINK2 }), [
      openItem(NOTICE_LINK, LINK),
    ]);
    expect(changed.supersede).toEqual([NOTICE_LINK]);
    expect(changed.open.map((o) => o.link)).toEqual([LINK2]);
  });

  it("a heartbeat (same link, same state) changes nothing", () => {
    expect(noticesFor(running(), running({ since: "2026-10-25T12:05:00.000Z" }))).toEqual({
      supersede: [],
      open: [],
    });
  });

  it("starting with no link yet opens nothing", () => {
    const { session_url: _, ...starting } = running({ state: "starting" });
    expect(noticesFor(null, starting).open).toEqual([]);
  });

  it("a volleyd restart adopting the same link does not open it again", () => {
    expect(noticesFor(null, running(), [openItem(NOTICE_LINK, LINK)])).toEqual({
      supersede: [],
      open: [],
    });
  });

  it("failed opens n-coordinator-failed with the last error and supersedes the link notice", () => {
    const { session_url: _, ...rest } = running();
    const failed = { ...rest, state: "failed" as const, last_error: "claude: exited 1" };
    const r = noticesFor(running(), failed, [openItem(NOTICE_LINK, LINK)]);
    expect(r.supersede).toEqual([NOTICE_LINK]);
    expect(r.open).toEqual([
      {
        notice: "coordinator-failed",
        machine: "box-a",
        name: "coord-test",
        title: "Coordinator on box-a stopped",
        question:
          "claude: exited 1\n\nRun `volley coordinator restart` (or Restart in Settings › Machines).",
      },
    ]);
    // Failed again (republished): nothing new; one already open after a restart: not twice.
    expect(noticesFor(failed, failed).open).toEqual([]);
    expect(noticesFor(null, failed, [openItem(NOTICE_FAILED)]).open).toEqual([]);
  });

  it("the role turned off supersedes the open notices", () => {
    expect(
      noticesFor(running(), null, [openItem(NOTICE_LINK, LINK), openItem(NOTICE_FAILED)]),
    ).toEqual({ supersede: [NOTICE_LINK, NOTICE_FAILED], open: [] });
    expect(noticesFor(running(), null, [])).toEqual({ supersede: [], open: [] });
  });
});

describe("itemForNotice (SPEC §4.6.18)", () => {
  it("an owner-only notice item, Open / Dismiss, valid against the schema", () => {
    const [spec] = noticesFor(null, running()).open;
    if (spec === undefined) throw new Error("no notice");
    const item = itemForNotice(spec, AT);
    expect(item).toEqual({
      id: "n-coordinator-link",
      kind: "notice",
      version: 1,
      owner_only: true,
      agent_id: "volleyd",
      title: "Coordinator on box-a: open it",
      question: LINK,
      options: [{ label: "open" }, { label: "dismiss" }],
      pointers: { link: LINK },
      opened_at: AT,
      source: { notice: "coordinator-link", machine: "box-a", name: "coord-test" },
    });
    expect(
      schemaErrors("inbox-item.schema.json", envelope(INBOX_CHANNEL, "inbox_item", item)),
    ).toEqual([]);
    expect(itemForNotice(spec, AT, 3).version).toBe(3);
  });
});
