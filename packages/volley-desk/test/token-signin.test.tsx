import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInGate } from "../src/auth/SignInGate";
import { CREDENTIALS_STORAGE_KEY, useDesk } from "../src/store/context";
import {
  type RedeemRequest,
  type RedeemResult,
  deviceLabel,
  parseToken,
  readSessionRole,
  signinTokenFromHash,
  takeFirstRun,
} from "../src/store/control";
import type { BrokerCredentials, DeskMqttClient } from "../src/store/mqtt-client";

const ID = "0123abcd";
const SIGNIN = `vly_signin_${ID}_0123456789abcdef0123456789abcdef`;
const ADMIN = `vly_admin_${ID}_fedcba9876543210fedcba9876543210`;

/** A connected fake broker client, recording what it was built with. */
function factory() {
  const calls: (BrokerCredentials | undefined)[] = [];
  const make = (_url: string, auth?: BrokerCredentials): DeskMqttClient => {
    calls.push(auth);
    const connected = new Set<() => void>();
    return {
      connect: async () => {
        for (const h of connected) h();
      },
      disconnect: async () => {},
      publish: async () => {},
      onMessage: () => () => {},
      onConnect: (h) => {
        connected.add(h);
        return () => connected.delete(h);
      },
      onDisconnect: () => () => {},
      onError: () => () => {},
    };
  };
  return { make, calls };
}

function Probe() {
  const { identity, connection } = useDesk();
  return (
    <div data-testid="desk">
      {connection}:{identity ?? "anonymous"}
    </div>
  );
}

function gate(f: ReturnType<typeof factory>, redeem: (r: RedeemRequest) => Promise<RedeemResult>) {
  return render(
    <SignInGate
      demo={false}
      env={{}}
      brokerUrl="ws://broker.test:9001"
      clientFactory={f.make}
      redeem={redeem}
    >
      <Probe />
    </SignInGate>,
  );
}

const stored = () => JSON.parse(localStorage.getItem(CREDENTIALS_STORAGE_KEY) ?? "null");

describe("one-time token helpers", () => {
  it("reads a token from #signin= and parses its kind and id", () => {
    expect(signinTokenFromHash(`#signin=${SIGNIN}`)).toBe(SIGNIN);
    expect(signinTokenFromHash("#other=1")).toBeNull();
    expect(signinTokenFromHash("")).toBeNull();
    expect(parseToken(SIGNIN)).toEqual({ kind: "signin", id: ID });
    expect(parseToken(ADMIN)).toEqual({ kind: "admin", id: ID });
    expect(parseToken("vly_admin_xyz_1")).toBeNull();
  });

  it("labels the browser after its device", () => {
    expect(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"),
    ).toBe("Desk on iPhone");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36")).toBe(
      "Desk on Android",
    );
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15")).toBe(
      "Desk on Mac",
    );
    expect(deviceLabel("")).toBe("Desk on this browser");
  });
});

describe("SignInGate #signin=<token>", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("redeems the link, stores the minted credential and signs in with it", async () => {
    window.history.replaceState(null, "", `/#signin=${SIGNIN}`);
    let ask: { url: string; token: string; label: string } | null = null;
    let finish: (r: RedeemResult) => void = () => {};
    const redeem = vi.fn(
      (r: { url: string; token: string; label: string }) =>
        new Promise<RedeemResult>((resolve) => {
          ask = r;
          finish = resolve;
        }),
    );
    const f = factory();
    gate(f, redeem);
    // The token is single use: it leaves the address bar (and history) at once.
    expect(window.location.hash).toBe("");
    expect(screen.getByText(/one-time link/i)).toBeInTheDocument();
    expect(ask).toEqual({ url: "ws://broker.test:9001", token: SIGNIN, label: expect.any(String) });
    await act(async () =>
      finish({
        ok: true,
        username: `steer-${ID}`,
        password: "s3cret",
        role: "steer",
        label: "Desk on iPhone",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("desk")).toHaveTextContent(`steer-${ID}`));
    expect(f.calls.at(-1)).toEqual({ username: `steer-${ID}`, password: "s3cret" });
    expect(stored()).toEqual({
      username: `steer-${ID}`,
      password: "s3cret",
      role: "steer",
      label: "Desk on iPhone",
    });
    expect(readSessionRole()).toBe("steer");
    expect(takeFirstRun()).toBe(false);
  });

  it("an admin token makes the browser an admin and opens setup once", async () => {
    window.history.replaceState(null, "", `/#signin=${ADMIN}`);
    const redeem = vi.fn(async () => ({
      ok: true as const,
      username: `admin-${ID}`,
      password: "pw",
      role: "admin",
      label: "Desk on Mac",
    }));
    gate(factory(), redeem);
    await waitFor(() => expect(screen.getByTestId("desk")).toHaveTextContent(`admin-${ID}`));
    expect(readSessionRole()).toBe("admin");
    expect(takeFirstRun()).toBe(true);
    expect(takeFirstRun()).toBe(false);
  });

  it("a burned token shows the error and the normal form, keeping any stored sign-in out", async () => {
    window.history.replaceState(null, "", `/#signin=${SIGNIN}`);
    const redeem = vi.fn(async () => ({ ok: false as const, error: "token already used" }));
    const f = factory();
    gate(f, redeem);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("token already used");
    expect(alert).toHaveTextContent(/new link/i);
    expect(screen.getByRole("form", { name: "Sign in to the broker" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(f.calls).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  it("without a link it keeps the stored sign-in and never redeems", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "desk", password: "pw" }),
    );
    const redeem = vi.fn();
    gate(factory(), redeem);
    await waitFor(() => expect(screen.getByTestId("desk")).toHaveTextContent("desk"));
    expect(redeem).not.toHaveBeenCalled();
  });
});
