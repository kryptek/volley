import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { INBOX_RELEASE_EVIDENCE, demoAutopilot, demoInbox } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { InboxItem } from "../src/store/types";
import { ReleaseItem, evidenceUrl, releaseArtifacts } from "../src/windows/inbox/ReleaseItem";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const STATE = reduceAll(initialState(), [...demoAutopilot(NOW), ...demoInbox(NOW)]);
const ITEM = STATE.inbox?.["r-autopilot-publish"] as InboxItem;
const ORIGIN = "http://desk.example:5199";

async function setup(evidence: unknown = INBOX_RELEASE_EVIDENCE, item: InboxItem = ITEM) {
  const loadEvidence = vi.fn(async () => evidence);
  const r = render(
    <ReleaseItem
      item={item}
      wave={STATE.waves.autopilot}
      origin={ORIGIN}
      loadEvidence={loadEvidence}
    />,
  );
  return { loadEvidence, ...r };
}

describe("a release item", () => {
  it("fetches the stage evidence JSON from the Desk's own evidence route", async () => {
    const { loadEvidence } = await setup();
    await waitFor(() => expect(loadEvidence).toHaveBeenCalledTimes(1));
    expect(loadEvidence).toHaveBeenCalledWith(`${ORIGIN}/evidence/autopilot/release/tag.json`);
  });

  it("draws the train's stages as a Stepper, the stage in play current", async () => {
    await setup();
    const train = screen.getByLabelText("Release train");
    expect(train).toHaveClass("stepper");
    const steps = within(train).getAllByRole("button");
    expect(steps.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Step 1: tag · verified",
      "Step 2: publish · awaiting go",
      "Step 3: announce · pending",
    ]);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(steps[0]).toHaveAttribute("data-status", "complete");
    expect(steps[2]).toHaveAttribute("data-status", "upcoming");
  });

  it("renders the changelog entries through the safe Markdown renderer", async () => {
    await setup();
    const log = await screen.findByRole("region", { name: "Changelog entries" });
    expect(within(log).getByText("Needs you").tagName).toBe("STRONG");
    expect(within(log).getByText("Only you").tagName).toBe("CODE");
    expect(
      within(log)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Phone layout with 48 px targets", "Owner-only items push to the phone"]);
  });

  it("shows the staging smoke screenshots from the Desk's origin", async () => {
    await setup();
    const imgs = await screen.findAllByRole("img", { name: /^Staging smoke/ });
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      `${ORIGIN}/evidence/autopilot/release/smoke-desk.png`,
      `${ORIGIN}/evidence/autopilot/release/smoke-phone.webp`,
    ]);
  });

  it("links the release PR, CI, the smoke log and the evidence; the guide is only a link", async () => {
    const { container } = await setup();
    const link = async (name: string) =>
      (await screen.findByRole("link", { name })).getAttribute("href");
    expect(await link("Release PR")).toBe("https://github.com/example-org/example-repo/pull/300");
    expect(await link("CI run")).toBe(
      "https://github.com/example-org/example-repo/actions/runs/77",
    );
    expect(await link("Smoke log")).toBe(`${ORIGIN}/evidence/autopilot/release/smoke.log`);
    expect(await link("Evidence")).toBe(`${ORIGIN}/evidence/autopilot/release/tag.md`);
    expect(await link("Release guide")).toBe("https://guide.example.com/releasing");
    // Never embedded.
    expect(container.querySelector("iframe, object, embed")).toBeNull();
    expect(container.querySelector('img[src*="guide.example.com"]')).toBeNull();
  });

  it("keeps a screenshot inside the evidence folder and drops what is not an image or a link", () => {
    const a = releaseArtifacts({
      artifacts: {
        screenshots: ["../../secrets/x.png", "notes.txt"],
        release_pr: "javascript:alert(1)",
        ci_runs: ["https://ok.example/1", "file:///etc/passwd"],
        guide_url: "data:text/html,x",
      },
    });
    expect(a.screenshots).toEqual(["../../secrets/x.png"]);
    expect(evidenceUrl(ORIGIN, "w1", "../../secrets/x.png")).toBe(
      `${ORIGIN}/evidence/w1/release/x.png`,
    );
    expect(a.release_pr).toBeUndefined();
    expect(a.ci_runs).toEqual(["https://ok.example/1"]);
    expect(a.guide_url).toBeUndefined();
  });

  it("takes inline evidence as is, and shows the train with no evidence at all", async () => {
    const inline = {
      ...ITEM,
      source: { wave: "autopilot", evidence: { json: INBOX_RELEASE_EVIDENCE } },
    } as InboxItem;
    const { loadEvidence } = await setup(null, inline);
    expect(loadEvidence).not.toHaveBeenCalled();
    expect(await screen.findByRole("link", { name: "Release PR" })).toBeInTheDocument();
  });

  it("follows a retained update that replaces the inline evidence", async () => {
    const withPr = (pr: string) =>
      ({
        ...ITEM,
        source: {
          wave: "autopilot",
          evidence: {
            json: {
              ...INBOX_RELEASE_EVIDENCE,
              artifacts: { ...INBOX_RELEASE_EVIDENCE.artifacts, release_pr: pr },
            },
          },
        },
      }) as InboxItem;
    const { rerender } = await setup(null, withPr("https://example.com/pull/1"));
    expect(screen.getByRole("link", { name: "Release PR" })).toHaveAttribute(
      "href",
      "https://example.com/pull/1",
    );
    rerender(
      <ReleaseItem
        item={withPr("https://example.com/pull/2")}
        wave={STATE.waves.autopilot}
        origin={ORIGIN}
        loadEvidence={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Release PR" })).toHaveAttribute(
      "href",
      "https://example.com/pull/2",
    );
  });

  it("with no evidence the train still shows and nothing else", async () => {
    const { container } = await setup(null);
    expect(screen.getByLabelText("Release train")).toBeInTheDocument();
    expect(container.querySelector(".inbox-changelog")).toBeNull();
    expect(container.querySelector(".inbox-shots")).toBeNull();
  });
});
