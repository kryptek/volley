import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepairSheet } from "../src/settings/RepairSheet";
import type { DoctorAnswer, DoctorCheck } from "../src/store/peerOps";
import { fakePeerOps } from "./helpers/peer-ops";

const flush = () => new Promise((r) => setTimeout(r, 0));

const hooks: DoctorCheck = {
  id: "hooks",
  ok: false,
  severity: "warn",
  detail: "the Volley hooks are not installed",
  fix: "env HOME=/home/agent bash install-hooks.sh",
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
