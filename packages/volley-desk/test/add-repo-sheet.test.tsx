import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddRepoSheet, type AddRepoSheetProps } from "../src/settings/AddRepoSheet";
import { shortReason } from "../src/settings/repos";
import type { RepoProbeResult } from "../src/store/peerOps";
import type { ReadinessPayload } from "../src/store/types";
import { fakePeerOps } from "./helpers/peer-ops";
import { APP, verdict } from "./helpers/repos";

const added = (machines: string[]) =>
  vi.fn(async () => ({
    ok: true as const,
    slug: APP,
    url: `https://github.com/${APP}`,
    machines,
    status: machines.map((m) => `${m}: cloning`),
  }));

function setup(props: Partial<AddRepoSheetProps> = {}) {
  const ops = fakePeerOps({ repoAdd: added(["hub", "box-a", "box-b"]) });
  const onClose = vi.fn();
  const base: AddRepoSheetProps = {
    ops,
    machines: ["hub", "box-a", "box-b"],
    localName: "hub",
    readiness: {},
    onClose,
    ...props,
  };
  const r = render(<AddRepoSheet {...base} />);
  const rerender = (more: Partial<AddRepoSheetProps>) =>
    r.rerender(<AddRepoSheet {...base} {...more} />);
  return { ops: (props.ops as ReturnType<typeof fakePeerOps>) ?? ops, onClose, rerender };
}

const sheet = () => within(screen.getByRole("dialog", { name: "Add repository" }));
const slug = () => sheet().getByRole("textbox", { name: "Repository (owner/name)" });
const type = (v: string) => fireEvent.change(slug(), { target: { value: v } });
const addButton = () => sheet().getByRole("button", { name: "Add" });

async function submit() {
  await act(async () => {
    fireEvent.click(addButton());
  });
}

const reason = () => sheet().queryByRole("status");
const tickClone = (m = "box-a") =>
  fireEvent.click(sheet().getByRole("checkbox", { name: `Use an existing clone on ${m}` }));
const typePath = (v: string, m = "box-a") =>
  fireEvent.change(sheet().getByRole("textbox", { name: `Existing clone on ${m}` }), {
    target: { value: v },
  });
/** The clone check's debounce passes and its answer lands. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}
const probing = (answer: RepoProbeResult) => vi.fn(async () => answer);
const REPO = "/srv/example-repo";

afterEach(() => {
  vi.useRealTimers();
});

describe("Add repository sheet", () => {
  it("validates the slug as it is typed: a URL, a lone name, then owner/name", () => {
    setup();
    expect(addButton()).toBeDisabled();
    type("https://github.com/example-org/app");
    expect(
      sheet().getByText("Use owner/name, not a URL", { selector: ".s-error" }),
    ).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    type("app");
    expect(
      sheet().getByText("slug must be a GitHub <owner/name>", { selector: ".s-error" }),
    ).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    type("example-org/app.git");
    expect(
      sheet().getByText("Leave off .git: owner/name", { selector: ".s-error" }),
    ).toBeInTheDocument();
    type(APP);
    expect(sheet().queryByText(/owner\/name/, { selector: ".s-error" })).toBeNull();
    expect(addButton()).toBeEnabled();
  });

  it("every machine is checked by default, and Add sends machines: all", async () => {
    const { ops } = setup();
    for (const m of ["hub", "box-a", "box-b"]) {
      expect(sheet().getByRole("checkbox", { name: m })).toBeChecked();
    }
    type(APP);
    await submit();
    expect(ops.repoAdd).toHaveBeenCalledWith(APP, { machines: "all" });
  });

  it("unchecked machines and an existing clone's path go as machines and paths", async () => {
    const { ops } = setup({ ops: fakePeerOps({ repoAdd: added(["hub", "box-a"]) }) });
    type(APP);
    fireEvent.click(sheet().getByRole("checkbox", { name: "box-b" }));
    // The supervisor's own clone is the managed one: no existing-clone choice there.
    expect(sheet().queryByRole("checkbox", { name: "Use an existing clone on hub" })).toBeNull();
    fireEvent.click(sheet().getByRole("checkbox", { name: "Use an existing clone on box-a" }));
    const path = sheet().getByRole("textbox", { name: "Existing clone on box-a" });
    fireEvent.change(path, { target: { value: "relative/app" } });
    expect(
      sheet().getByText("an absolute path, starting with /", { selector: ".s-error" }),
    ).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    vi.useFakeTimers();
    fireEvent.change(path, { target: { value: "/srv/work/app" } });
    await settle();
    expect(
      sheet().getByText(
        "volley repo add example-org/app --machine hub --machine box-a --path box-a=/srv/work/app",
        {
          selector: "code",
        },
      ),
    ).toBeInTheDocument();
    await submit();
    expect(ops.repoAdd).toHaveBeenCalledWith(APP, {
      machines: ["hub", "box-a"],
      paths: { "box-a": "/srv/work/app" },
    });
  });

  it("an existing clone ticked with no path keeps Add disabled", async () => {
    vi.useFakeTimers();
    setup();
    type(APP);
    tickClone();
    expect(addButton()).toBeDisabled();
    typePath("/srv/work/app");
    await settle();
    expect(addButton()).toBeEnabled();
  });

  it("no machine checked: nothing to add to", () => {
    setup();
    type(APP);
    for (const m of ["hub", "box-a", "box-b"]) {
      fireEvent.click(sheet().getByRole("checkbox", { name: m }));
    }
    expect(addButton()).toBeDisabled();
  });

  it("progress per machine follows readiness; Done once each is ready or blocked", async () => {
    const r = (states: Record<string, "ready" | "cloning" | "blocked" | "absent">) =>
      Object.fromEntries(
        Object.entries(states).map(([m, state]) => [
          m,
          verdict(m, {
            [APP]: { state, reasons: state === "blocked" ? ["gh: not signed in"] : [] },
          }),
        ]),
      ) as Record<string, ReadinessPayload>;
    const { rerender } = setup({ readiness: r({ hub: "absent" }) });
    type(APP);
    await submit();
    const progress = () => within(sheet().getByRole("list", { name: `Progress for ${APP}` }));
    expect(progress().getByRole("listitem", { name: "hub: no clone yet" })).toBeInTheDocument();
    expect(progress().getByRole("listitem", { name: "box-a: starting…" })).toBeInTheDocument();
    const done = () => sheet().getByRole("button", { name: "Done" });
    expect(done()).toBeDisabled();
    rerender({ readiness: r({ hub: "ready", "box-a": "cloning", "box-b": "cloning" }) });
    expect(progress().getByRole("listitem", { name: "box-a: cloning…" })).toBeInTheDocument();
    expect(done()).toBeDisabled();
    rerender({ readiness: r({ hub: "ready", "box-a": "ready", "box-b": "blocked" }) });
    expect(
      progress().getByRole("listitem", { name: "box-b: blocked: gh: not signed in" }),
    ).toBeInTheDocument();
    expect(done()).toBeEnabled();
  });

  it("a refused add shows volleyd's reason and keeps the form", async () => {
    setup({
      ops: fakePeerOps({
        repoAdd: vi.fn(async () => ({
          ok: false as const,
          error: "GraphQL: Could not resolve to a Repository",
        })),
      }),
    });
    type("example-org/nope");
    await submit();
    expect(sheet().getByRole("alert")).toHaveTextContent("Could not resolve to a Repository");
    expect(slug()).toHaveValue("example-org/nope");
  });

  it("says why Add is disabled, first reason first, and nothing once Add is enabled", () => {
    setup();
    expect(addButton()).toBeDisabled();
    expect(reason()).toHaveTextContent("Enter owner/name");
    type("app");
    expect(reason()).toHaveTextContent("slug must be a GitHub <owner/name>");
    type(APP);
    expect(addButton()).toBeEnabled();
    expect(reason()).toBeNull();
    for (const m of ["hub", "box-a", "box-b"]) {
      fireEvent.click(sheet().getByRole("checkbox", { name: m }));
    }
    expect(reason()).toHaveTextContent("Pick at least one machine");
    fireEvent.click(sheet().getByRole("checkbox", { name: "box-a" }));
    tickClone();
    expect(addButton()).toBeDisabled();
    expect(reason()).toHaveTextContent("Enter the clone's path on box-a");
    typePath("relative/app");
    expect(reason()).toHaveTextContent("an absolute path, starting with /");
  });

  it("checks the path on the machine once typing stops, and a clone of a GitHub repository fills owner/name", async () => {
    vi.useFakeTimers();
    const repoProbe = probing({
      ok: true,
      state: "found",
      root: REPO,
      origin: "https://github.com/example-org/example-repo.git",
      slug: "example-org/example-repo",
    });
    setup({ ops: fakePeerOps({ repoProbe }) });
    tickClone();
    for (const v of ["/", "/srv", "/srv/example", REPO]) typePath(v);
    expect(repoProbe).not.toHaveBeenCalled();
    expect(reason()).toHaveTextContent("Enter owner/name");
    await settle();
    expect(repoProbe).toHaveBeenCalledTimes(1);
    expect(repoProbe).toHaveBeenCalledWith("box-a", REPO);
    expect(slug()).toHaveValue("example-org/example-repo");
    expect(sheet().getByText("Clone of example-org/example-repo")).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
    expect(reason()).toBeNull();
  });

  it("never overwrites an owner/name the person typed: a different clone blocks Add instead", async () => {
    vi.useFakeTimers();
    const repoProbe = probing({
      ok: true,
      state: "found",
      root: REPO,
      origin: "git@github.com:example-org/other-repo.git",
      slug: "example-org/other-repo",
    });
    setup({ ops: fakePeerOps({ repoProbe }) });
    type("example-org/example-repo");
    tickClone();
    typePath(REPO);
    await settle();
    expect(slug()).toHaveValue("example-org/example-repo");
    const why = "This clone is example-org/other-repo, not example-org/example-repo";
    expect(reason()).toHaveTextContent(why);
    expect(addButton()).toBeDisabled();
  });

  it("an owner/name typed and cleared again is not filled in either", async () => {
    vi.useFakeTimers();
    setup();
    type("x");
    type("");
    tickClone();
    typePath(REPO);
    await settle();
    expect(slug()).toHaveValue("");
  });

  it.each([
    ["missing", `No folder at ${REPO} on box-a`],
    ["not_git", `${REPO} on box-a is not a git clone`],
  ] as const)("%s: says so with the untick hint, and Add is disabled", async (state, line) => {
    vi.useFakeTimers();
    setup({ ops: fakePeerOps({ repoProbe: probing({ ok: true, state }) }) });
    type(APP);
    tickClone();
    typePath(REPO);
    await settle();
    expect(sheet().getByText(line, { selector: ".s-error" })).toBeInTheDocument();
    expect(
      sheet().getByText('Untick "use an existing clone" to clone it there instead'),
    ).toBeInTheDocument();
    expect(reason()).toHaveTextContent(line);
    expect(addButton()).toBeDisabled();
  });

  it("no_origin: says so, and Add stays enabled (the doctor explains it after the add)", async () => {
    vi.useFakeTimers();
    setup({
      ops: fakePeerOps({ repoProbe: probing({ ok: true, state: "no_origin", root: REPO }) }),
    });
    type(APP);
    tickClone();
    typePath(REPO);
    await settle();
    expect(sheet().getByText(`${REPO} on box-a has no origin remote`)).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it("while the check runs Add waits; an unanswered check leaves Add enabled", async () => {
    vi.useFakeTimers();
    let answer!: (r: RepoProbeResult) => void;
    const repoProbe = vi.fn(
      () =>
        new Promise<RepoProbeResult>((r) => {
          answer = r;
        }),
    );
    setup({ ops: fakePeerOps({ repoProbe }) });
    type(APP);
    tickClone();
    typePath(REPO);
    expect(reason()).toHaveTextContent(`Checking ${REPO} on box-a…`);
    await settle();
    expect(addButton()).toBeDisabled();
    expect(reason()).toHaveTextContent(`Checking ${REPO} on box-a…`);
    await act(async () => {
      answer({ ok: false, error: "ssh to you@box-a failed (clone probe): Connection refused" });
    });
    expect(
      sheet().getByText(
        "Could not check box-a: ssh to you@box-a failed (clone probe): Connection refused",
      ),
    ).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it("an answer for a path since changed is ignored, and unticking clears the check", async () => {
    vi.useFakeTimers();
    const answers: ((r: RepoProbeResult) => void)[] = [];
    const repoProbe = vi.fn(
      () =>
        new Promise<RepoProbeResult>((r) => {
          answers.push(r);
        }),
    );
    setup({ ops: fakePeerOps({ repoProbe }) });
    type(APP);
    tickClone();
    typePath("/srv/old");
    await settle();
    typePath(REPO);
    await act(async () => {
      answers[0]?.({ ok: true, state: "missing" });
    });
    expect(sheet().queryByText("No folder at /srv/old on box-a")).toBeNull();
    expect(reason()).toHaveTextContent(`Checking ${REPO} on box-a…`);
    tickClone();
    expect(addButton()).toBeEnabled();
    expect(reason()).toBeNull();
  });

  it("in the added phase a blocked chip shows a short reason and a Why with every reason in full", async () => {
    const long =
      "volley peer doctor on you@box-b printed no report: bash: line 2: volley: command not found";
    const r: Record<string, ReadinessPayload> = {
      hub: verdict("hub", { [APP]: { state: "ready", reasons: [] } }),
      "box-a": verdict("box-a", { [APP]: { state: "ready", reasons: [] } }),
      "box-b": verdict("box-b", { [APP]: { state: "blocked", reasons: [long] } }),
    };
    setup({ readiness: r });
    type(APP);
    await submit();
    const progress = within(sheet().getByRole("list", { name: `Progress for ${APP}` }));
    const chip = within(
      progress.getByRole("listitem", {
        name: "box-b: blocked: volley peer doctor on you@box-b printed no report…",
      }),
    );
    const why = chip.getByRole("button", { name: "Why" });
    expect(why).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(why);
    expect(why).toHaveAttribute("aria-expanded", "true");
    expect(chip.getByText(long)).toBeInTheDocument();
    expect(
      within(progress.getByRole("listitem", { name: "hub: ready" })).queryByRole("button"),
    ).toBeNull();
  });

  it("Escape closes it", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("shortReason", () => {
  it("cuts at the first `: ` past 24 characters, or at 72, with …", () => {
    expect(
      shortReason([
        "volley peer doctor on you@box-b printed no report: bash: line 2: volley: command not found",
      ]),
    ).toBe("volley peer doctor on you@box-b printed no report…");
    expect(shortReason(["box-b is down: retried when it is back"])).toBe(
      "box-b is down: retried when it is back",
    );
    const long = "a".repeat(100);
    expect(shortReason([long])).toBe(`${"a".repeat(72)}…`);
    expect(shortReason([])).toBe("");
  });
});
