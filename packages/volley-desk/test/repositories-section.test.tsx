import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Repositories, type RepositoriesProps } from "../src/settings/Repositories";
import { fakePeerOps } from "./helpers/peer-ops";
import { APP, LIB, machines, readiness, repoConfig, verdict } from "./helpers/repos";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(props: Partial<RepositoriesProps> = {}) {
  const ops = fakePeerOps();
  const base: RepositoriesProps = {
    config: repoConfig(),
    machines: machines(),
    readiness: readiness(),
    ops,
    hubUp: true,
    ...props,
  };
  const r = render(<Repositories {...base} />);
  const rerender = (more: Partial<RepositoriesProps>) =>
    r.rerender(<Repositories {...base} {...more} />);
  return { ...r, ops: (props.ops as ReturnType<typeof fakePeerOps>) ?? ops, rerender };
}

const row = (slug: string) => screen.getByRole("article", { name: slug });
const chips = (slug: string) =>
  within(within(row(slug)).getByRole("list", { name: `Machines for ${slug}` }));

describe("Settings › Repositories", () => {
  it("one row per configured repository, its slug linking to GitHub", async () => {
    setup();
    await act(flush);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(within(row(APP)).getByRole("link", { name: APP })).toHaveAttribute(
      "href",
      "https://github.com/example-org/app",
    );
    expect(within(row(LIB)).getByRole("link", { name: LIB })).toHaveAttribute(
      "href",
      "https://github.com/example-org/lib",
    );
  });

  it("a chip per assigned machine (all: the supervisor's own and every paired one), from readiness", async () => {
    setup();
    await act(flush);
    const app = chips(APP);
    expect(app.getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual([
      `hub: blocked: java not installed (needed by ${APP})`,
      "box-a: ready",
      "box-b: blocked: box-b is down: retried when it is back",
    ]);
    expect(chips(LIB).getAllByRole("listitem")).toHaveLength(1);
    expect(chips(LIB).getByRole("listitem", { name: "box-a: ready" })).toBeInTheDocument();
  });

  it("a repository adopted on the supervisor's machine (fleet.repos) has its chip there (#616)", async () => {
    const config = repoConfig({ [LIB]: { machines: ["box-a"] } });
    config.fleet = { ...config.fleet, repos: { "example-org/widgets": "/src/widgets" } };
    setup({ config });
    await act(flush);
    expect(screen.getByRole("article", { name: "example-org/widgets" })).toBeInTheDocument();
    expect(
      chips("example-org/widgets")
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("aria-label")?.split(":")[0]),
    ).toEqual(["hub"]);
  });

  it("cloning shows as cloning…, a machine with no verdict yet as waiting", async () => {
    const { "box-b": _gone, ...r } = readiness();
    r["box-a"] = verdict("box-a", { [APP]: { state: "cloning", reasons: [] } });
    setup({ readiness: r });
    await act(flush);
    expect(chips(APP).getByRole("listitem", { name: "box-a: cloning…" })).toBeInTheDocument();
    expect(
      chips(APP).getByRole("listitem", { name: "box-b: waiting for volleyd" }),
    ).toBeInTheDocument();
  });

  it("the toolchain summary names what a machine lacks for the repository", async () => {
    setup();
    await act(flush);
    expect(within(row(APP)).getByText("needs java on hub")).toBeInTheDocument();
    expect(within(row(LIB)).getByText("toolchain ok")).toBeInTheDocument();
  });

  it("a blocked paired machine has Repair inline, which runs that machine's doctor", async () => {
    const { ops } = setup();
    await act(flush);
    const chip = within(chips(APP).getByRole("listitem", { name: /^box-b:/ }));
    await act(async () => {
      fireEvent.click(chip.getByRole("button", { name: "Repair box-b" }));
    });
    expect(screen.getByRole("dialog", { name: "Repair box-b" })).toBeInTheDocument();
    expect(ops.doctor).toHaveBeenCalledWith("box-b", { fix: false });
    // The supervisor's own machine is not repaired over ssh: its blocked chip has no Repair.
    const hub = within(chips(APP).getByRole("listitem", { name: /^hub:/ }));
    expect(hub.queryByRole("button", { name: /^Repair/ })).toBeNull();
  });

  it("a blocked chip shows a short reason and a Why that opens every reason in full; Repair stays beside it", async () => {
    const long =
      "volley peer doctor on you@box-b printed no report: bash: line 2: volley: command not found";
    const r = readiness();
    r["box-b"] = verdict("box-b", {
      [APP]: { state: "blocked", reasons: [long, "gh: not signed in"] },
    });
    setup({ readiness: r });
    await act(flush);
    const li = chips(APP).getByRole("listitem", {
      name: "box-b: blocked: volley peer doctor on you@box-b printed no report…",
    });
    expect(li).toHaveAttribute("title", `${long}\ngh: not signed in`);
    const chip = within(li);
    expect(chip.getByRole("button", { name: "Repair box-b" })).toBeInTheDocument();
    const why = chip.getByRole("button", { name: "Why" });
    expect(why).toHaveAttribute("aria-expanded", "false");
    expect(chip.queryByText(long)).toBeNull();
    fireEvent.click(why);
    expect(why).toHaveAttribute("aria-expanded", "true");
    expect(chip.getByText(long)).toBeInTheDocument();
    expect(chip.getByText("gh: not signed in")).toBeInTheDocument();
    fireEvent.click(why);
    expect(chip.queryByText(long)).toBeNull();
    // A chip that is not blocked has no Why.
    expect(
      within(chips(APP).getByRole("listitem", { name: "box-a: ready" })).queryByRole("button"),
    ).toBeNull();
  });

  it("Remove… confirms with the clone paths left on disk, sends repo_remove, and says what stayed", async () => {
    const repoRemove = vi.fn(async () => ({
      ok: true as const,
      slug: LIB,
      machines: ["box-a"],
      clones: { "box-a": "/path/to/home/.volley/repos/example-org/lib" },
      peers: { "box-a": "removed" },
    }));
    const { ops } = setup({ ops: fakePeerOps({ repoRemove }) });
    await act(flush);
    fireEvent.click(within(row(LIB)).getByRole("button", { name: `Remove ${LIB}…` }));
    const confirm = within(screen.getByRole("dialog", { name: `Remove ${LIB}` }));
    expect(confirm.getByText(/never deleted/)).toBeInTheDocument();
    expect(confirm.getByText("/path/to/home/.volley/repos/example-org/lib")).toBeInTheDocument();
    expect(ops.repoRemove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(confirm.getByRole("button", { name: "Remove" }));
    });
    expect(ops.repoRemove).toHaveBeenCalledWith(LIB);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(`Removed ${LIB}`);
    expect(notice).toHaveTextContent("box-a: /path/to/home/.volley/repos/example-org/lib");
  });

  it("a refused remove says why in the sheet", async () => {
    const repoRemove = vi.fn(async () => ({ ok: false as const, error: "not an admin" }));
    setup({ ops: fakePeerOps({ repoRemove }) });
    await act(flush);
    fireEvent.click(within(row(LIB)).getByRole("button", { name: `Remove ${LIB}…` }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    });
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("not an admin");
  });

  it("the footer names the CLI twin; nothing tells the person to run the doctor by hand", async () => {
    const { container } = setup();
    await act(flush);
    expect(
      screen.getByText("volley repo add owner/name --machine box-a", { selector: "code" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("volley peer doctor");
  });

  it("Add repository… opens the Add sheet", async () => {
    setup();
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "Add repository…" }));
    expect(screen.getByRole("dialog", { name: "Add repository" })).toBeInTheDocument();
  });

  it("no repositories yet: says what adding one does", async () => {
    setup({ config: { ...repoConfig(), repos: {} } });
    await act(flush);
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText(/No repositories yet/)).toBeInTheDocument();
  });

  it("a non-admin (or no op channel) sees the rows read-only", async () => {
    setup({ ops: fakePeerOps({ admin: vi.fn(async () => "not-admin" as const) }) });
    await act(flush);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add repository…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Repair/ })).toBeNull();
    expect(screen.getByText(/takes an admin account/)).toBeInTheDocument();
  });
});
