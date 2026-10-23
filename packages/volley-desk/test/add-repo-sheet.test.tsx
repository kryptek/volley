import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddRepoSheet, type AddRepoSheetProps } from "../src/settings/AddRepoSheet";
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

describe("Add repository sheet", () => {
  it("validates the slug as it is typed: a URL, a lone name, then owner/name", () => {
    setup();
    expect(addButton()).toBeDisabled();
    type("https://github.com/example-org/app");
    expect(sheet().getByText("Use owner/name, not a URL")).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    type("app");
    expect(sheet().getByText("slug must be a GitHub <owner/name>")).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    type("example-org/app.git");
    expect(sheet().getByText("Leave off .git: owner/name")).toBeInTheDocument();
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
    expect(sheet().getByText("an absolute path, starting with /")).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    fireEvent.change(path, { target: { value: "/srv/work/app" } });
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

  it("an existing clone ticked with no path keeps Add disabled", () => {
    setup();
    type(APP);
    fireEvent.click(sheet().getByRole("checkbox", { name: "Use an existing clone on box-a" }));
    expect(addButton()).toBeDisabled();
    fireEvent.change(sheet().getByRole("textbox", { name: "Existing clone on box-a" }), {
      target: { value: "/srv/work/app" },
    });
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

  it("Escape closes it", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
