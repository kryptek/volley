import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepairSheet } from "../src/settings/RepairSheet";
import { fixFor } from "../src/settings/machineFixes";
import type { RepoOnMachine } from "../src/settings/repos";
import type { DoctorAnswer, DoctorCheck } from "../src/store/peerOps";
import { fakePeerOps } from "./helpers/peer-ops";
import { APP, LIB } from "./helpers/repos";

const flush = () => new Promise((r) => setTimeout(r, 0));

const hooks: DoctorCheck = {
  id: "hooks",
  ok: false,
  severity: "warn",
  detail: "the Volley hooks are not installed",
  fix: "env HOME=/path/to/home bash install-hooks.sh",
};
const gh: DoctorCheck = {
  id: "gh.auth",
  ok: false,
  severity: "block",
  detail: "gh is not signed in",
  fix: "gh auth login",
};
const clone: DoctorCheck = {
  id: "repo.clone",
  ok: false,
  severity: "block",
  detail: "no clone at /srv/work/repo",
  fix: "git clone https://github.com/example-org/example-repo /srv/work/repo",
};

const dry: DoctorAnswer = { ok: true, checks: [hooks, gh, clone], plan: [hooks, gh, clone] };

function setup(answers: DoctorAnswer[] = [dry]) {
  const queue = [...answers];
  const ops = fakePeerOps({
    doctor: vi.fn(async () => queue.shift() ?? { ok: true as const, checks: [], plan: [] }),
  });
  const onClose = vi.fn();
  render(<RepairSheet machine="box-a" ops={ops} onClose={onClose} />);
  return { ops, onClose };
}

const sheet = () => within(screen.getByRole("dialog", { name: "Repair box-a" }));

describe("Repair sheet (peer_doctor)", () => {
  it("opening runs a dry run and shows the plan before anything is applied", async () => {
    const { ops } = setup();
    expect(ops.doctor).toHaveBeenCalledWith("box-a", { fix: false });
    expect(screen.getByRole("dialog", { name: "Repair box-a" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(sheet().getByText(/Running the doctor on box-a/)).toBeInTheDocument();
    await act(flush);
    const will = within(sheet().getByRole("list", { name: "This will" }));
    expect(will.getByText(/installs the Volley hooks/)).toBeInTheDocument();
    const yours = within(sheet().getByRole("list", { name: "You run on box-a" }));
    expect(yours.getByText("gh auth login")).toBeInTheDocument();
    // The clone runs only with the switch on, so until then it is the owner's to run.
    expect(
      yours.getByText("git clone https://github.com/example-org/example-repo /srv/work/repo"),
    ).toBeInTheDocument();
    expect(ops.doctor).toHaveBeenCalledTimes(1);
  });

  it("Apply sends fix: true with clone off by default", async () => {
    const { ops } = setup([dry, { ok: true, checks: [{ ...hooks, ok: true }], plan: [] }]);
    await act(flush);
    expect(sheet().getByRole("switch", { name: "Also clone the wave repo" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Apply" }));
    });
    expect(ops.doctor).toHaveBeenLastCalledWith("box-a", { fix: true, clone: false });
  });

  it("the clone switch moves the clone into This will and sends clone: true", async () => {
    const { ops } = setup();
    await act(flush);
    fireEvent.click(sheet().getByRole("switch", { name: "Also clone the wave repo" }));
    const will = within(sheet().getByRole("list", { name: "This will" }));
    expect(will.getByText(/clones the wave repo/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Apply" }));
    });
    expect(ops.doctor).toHaveBeenLastCalledWith("box-a", { fix: true, clone: true });
  });

  it("after Apply the rows re-render from the answer's checks", async () => {
    setup([
      dry,
      { ok: true, checks: [{ ...hooks, ok: true, detail: "hooks installed" }, gh], plan: [] },
    ]);
    await act(flush);
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Apply" }));
    });
    const after = within(sheet().getByRole("list", { name: "Checks after the fix" }));
    expect(after.getByRole("listitem", { name: /^hooks/ })).toHaveTextContent("✓");
    expect(after.getByRole("listitem", { name: /^gh\.auth/ })).toHaveTextContent("✗");
  });

  it("an ok: false answer shows the transport's reason", async () => {
    setup([{ ok: false, error: "ssh: connect to host box-a port 22: timed out" }]);
    await act(flush);
    expect(sheet().getByRole("alert")).toHaveTextContent(
      "ssh: connect to host box-a port 22: timed out",
    );
    expect(sheet().queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("Escape and Close close it", async () => {
    const { onClose } = setup();
    await act(flush);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(sheet().getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Repair sheet: one row per repository on the machine", () => {
  const app: RepoOnMachine = {
    slug: APP,
    state: "absent",
    path: "/srv/work/app",
    managed: true,
    reasons: [`no clone of ${APP} at /srv/work/app`],
    missing: [],
    outdated: [],
  };
  const lib: RepoOnMachine = {
    slug: LIB,
    state: "blocked",
    path: "/srv/adopted/lib",
    managed: false,
    reasons: [`java not installed (needed by ${LIB})`],
    missing: ["java"],
    outdated: ["node"],
  };
  const appClone: DoctorCheck = {
    id: "repo.clone",
    repo: APP,
    ok: false,
    severity: "block",
    detail: "no clone at /srv/work/app",
  };
  const libOrigin: DoctorCheck = {
    id: "repo.origin",
    repo: LIB,
    ok: false,
    severity: "block",
    detail: "origin is github.com/someone/else",
  };

  function setupRepos(repos: RepoOnMachine[], answers: DoctorAnswer[]) {
    const queue = [...answers];
    const ops = fakePeerOps({
      doctor: vi.fn(async () => queue.shift() ?? { ok: true as const, checks: [], plan: [] }),
    });
    render(<RepairSheet machine="box-a" ops={ops} repos={repos} onClose={() => {}} />);
    return ops;
  }

  it("a row per repository replaces the one wave-repo switch; a missing clone is cloned by default", async () => {
    const ops = setupRepos(
      [app, lib],
      [{ ok: true, checks: [appClone, libOrigin], plan: [appClone, libOrigin] }],
    );
    await act(flush);
    expect(sheet().queryByRole("switch", { name: "Also clone the wave repo" })).toBeNull();
    const rows = within(sheet().getByRole("list", { name: "Repositories on box-a" }));
    const appRow = within(rows.getByRole("listitem", { name: APP }));
    expect(appRow.getByRole("switch", { name: `Clone ${APP}` })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const libRow = within(rows.getByRole("listitem", { name: LIB }));
    // A clone that exists is not cloned again; what it lacks is the person's to install.
    expect(libRow.queryByRole("switch")).toBeNull();
    expect(libRow.getByText(`install java on box-a (needed by ${LIB})`)).toBeInTheDocument();
    expect(libRow.getByText(`update node on box-a (needed by ${LIB})`)).toBeInTheDocument();
    // The clone runs under Repair, named by its repository; the repoint is the person's.
    const will = within(sheet().getByRole("list", { name: "This will" }));
    expect(will.getByText(`Repair clones ${APP} to /srv/work/app`)).toBeInTheDocument();
    const yours = within(sheet().getByRole("list", { name: "You run on box-a" }));
    expect(
      yours.getByText(
        (_, el) => el?.tagName === "CODE" && el.textContent === "git -C /srv/adopted/lib remote -v",
      ),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Apply" }));
    });
    expect(ops.doctor).toHaveBeenLastCalledWith("box-a", {
      fix: true,
      clone: true,
      reposAdd: [APP],
    });
  });

  it("an adopted clone is cloned at its own path; switching a clone off leaves it to the person", async () => {
    const ops = setupRepos(
      [{ ...lib, state: "absent", missing: [], outdated: [], reasons: [] }, app],
      [{ ok: true, checks: [hooks], plan: [hooks] }],
    );
    await act(flush);
    fireEvent.click(sheet().getByRole("switch", { name: `Clone ${APP}` }));
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Apply" }));
    });
    expect(ops.doctor).toHaveBeenLastCalledWith("box-a", {
      fix: true,
      clone: true,
      reposAdd: [`${LIB}=/srv/adopted/lib`],
    });
  });

  it("with every clone switched off Apply sends no repositories", async () => {
    const ops = setupRepos([app], [{ ok: true, checks: [hooks], plan: [hooks] }]);
    await act(flush);
    fireEvent.click(sheet().getByRole("switch", { name: `Clone ${APP}` }));
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Apply" }));
    });
    expect(ops.doctor).toHaveBeenLastCalledWith("box-a", { fix: true, clone: false });
  });
});

describe("machineFixes per repository", () => {
  const ctx = {
    machine: "box-a",
    repos: [
      { slug: APP, path: "/srv/work/app" },
      { slug: LIB, path: "/srv/adopted/lib" },
    ],
  };
  it("repo.* fixes name the check's repository and its clone", () => {
    expect(fixFor("repo.clone", ctx, APP)).toEqual({
      text: `Repair clones ${APP} to /srv/work/app`,
      safe: true,
      needsClone: true,
    });
    expect(fixFor("repo.origin", ctx, LIB)).toMatchObject({
      text: `point the clone at ${LIB}, after checking /srv/adopted/lib is the one you meant`,
      command: "git -C /srv/adopted/lib remote -v",
    });
    expect(fixFor("repo.fetch", ctx, LIB)?.command).toBe("git -C /srv/adopted/lib fetch origin");
    expect(fixFor("claude.trust", ctx, APP)?.command).toBe("cd /srv/work/app && claude");
  });

  it("a repository with no clone yet never borrows the wave repo's path", () => {
    const c = { machine: "box-a", repo: "/srv/work/wave", repos: [{ slug: APP }] };
    expect(fixFor("repo.clone", c, LIB)?.text).toBe(`Repair clones ${LIB} to <the repo's clone>`);
    expect(fixFor("repo.fetch", c, APP)?.command).toBe("git -C <the repo's clone> fetch origin");
    expect(fixFor("repo.fetch", c)?.command).toBe("git -C /srv/work/wave fetch origin");
  });

  it("tool.<name> names the repository that needs it", () => {
    expect(fixFor("tool.java", ctx, LIB)?.text).toBe(
      `install java on box-a (needed by ${LIB}), on the PATH its agents get`,
    );
    expect(fixFor("tool.tmux", ctx)?.text).toBe(
      "install tmux on box-a, on the PATH its agents get",
    );
  });
});
