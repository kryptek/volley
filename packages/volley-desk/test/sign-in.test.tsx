import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInGate } from "../src/auth/SignInGate";
import { CREDENTIALS_STORAGE_KEY, DeskStoreProvider, useDesk } from "../src/store/context";
import {
  AuthFailedError,
  type BrokerCredentials,
  type DeskMqttClient,
} from "../src/store/mqtt-client";

/** A fake broker client: `refuse` makes connect() reject as the broker would on CONNACK 4/5. */
function factory(opts: { refuse?: boolean } = {}) {
  const calls: { url: string; auth: BrokerCredentials | undefined }[] = [];
  /** Every client's `onError` handlers: a refusal on a later reconnect arrives here. */
  const errorHandlers = new Set<(err: Error) => void>();
  let disconnects = 0;
  const make = (url: string, auth?: BrokerCredentials): DeskMqttClient => {
    calls.push({ url, auth });
    const connected = new Set<() => void>();
    return {
      connect: async () => {
        if (opts.refuse) throw new AuthFailedError("Connection refused: Bad username or password");
        for (const h of connected) h();
      },
      disconnect: async () => {
        disconnects++;
      },
      publish: async () => {},
      onMessage: () => () => {},
      onConnect: (h) => {
        connected.add(h);
        return () => connected.delete(h);
      },
      onDisconnect: () => () => {},
      onError: (h) => {
        errorHandlers.add(h);
        return () => errorHandlers.delete(h);
      },
    };
  };
  const error = (err: Error) => {
    for (const h of [...errorHandlers]) h(err);
  };
  return { make, calls, error, disconnects: () => disconnects };
}

function Probe() {
  const { identity, connection } = useDesk();
  return (
    <div data-testid="desk">
      {connection}:{identity ?? "anonymous"}
    </div>
  );
}

const flush = () => act(async () => {});

function gate(f: ReturnType<typeof factory>, env: Record<string, unknown> = {}) {
  return render(
    <SignInGate demo={false} env={env} brokerUrl="ws://broker.test:9001" clientFactory={f.make}>
      <Probe />
    </SignInGate>,
  );
}

function signIn(username: string, password: string) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("SignInGate (P1-2)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("asks for credentials before connecting, naming the broker", () => {
    const f = factory();
    gate(f);
    expect(screen.getByRole("form", { name: "Sign in to the broker" })).toBeInTheDocument();
    expect(screen.getByText("ws://broker.test:9001")).toBeInTheDocument();
    expect(screen.queryByTestId("desk")).not.toBeInTheDocument();
    expect(f.calls).toHaveLength(0);
  });

  it("signs in: stores the credentials under volley-desk:broker-auth and connects with them", async () => {
    const f = factory();
    gate(f);
    signIn(" desk ", "s3cret");
    await flush();
    expect(JSON.parse(localStorage.getItem(CREDENTIALS_STORAGE_KEY) ?? "null")).toEqual({
      username: "desk",
      password: "s3cret",
    });
    expect(f.calls.at(-1)?.auth).toEqual({ username: "desk", password: "s3cret" });
    expect(screen.getByTestId("desk")).toHaveTextContent("connected:desk");
  });

  it("skips the form when credentials are stored", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "desk", password: "pw" }),
    );
    const f = factory();
    gate(f);
    await flush();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(f.calls.at(-1)?.auth).toEqual({ username: "desk", password: "pw" });
  });

  it("forgets a refused password and shows the form again with the broker's reason", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "desk", password: "wrong" }),
    );
    const f = factory({ refuse: true });
    gate(f);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(/Bad username or password/);
    expect(localStorage.getItem(CREDENTIALS_STORAGE_KEY)).toBeNull();
    expect(screen.getByLabelText("Username")).toHaveValue("desk");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByTestId("desk")).not.toBeInTheDocument();
  });

  it("a refusal on a later reconnect (password rotated) forgets it and shows the form again", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "desk", password: "old" }),
    );
    const f = factory();
    gate(f);
    await flush();
    expect(screen.getByTestId("desk")).toHaveTextContent("connected:desk");
    act(() => f.error(new AuthFailedError("Connection refused: Not authorized")));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(/Not authorized/);
    expect(localStorage.getItem(CREDENTIALS_STORAGE_KEY)).toBeNull();
    expect(screen.getByLabelText("Username")).toHaveValue("desk");
    expect(screen.queryByTestId("desk")).not.toBeInTheDocument();
  });

  it("an empty username connects anonymously (read-only) and is remembered", async () => {
    const f = factory();
    gate(f);
    signIn("", "");
    await flush();
    expect(f.calls.at(-1)?.auth).toBeUndefined();
    expect(screen.getByTestId("desk")).toHaveTextContent("connected:anonymous");
    expect(JSON.parse(localStorage.getItem(CREDENTIALS_STORAGE_KEY) ?? "null")).toEqual({
      username: "",
      password: "",
    });
  });

  it("refuses a username outside the agent-id grammar without storing it", () => {
    const f = factory();
    gate(f);
    signIn("Desk User", "pw");
    expect(screen.getByRole("alert")).toHaveTextContent(/not a valid agent id/);
    expect(localStorage.getItem(CREDENTIALS_STORAGE_KEY)).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("dev-only VITE_VOLLEY_BROKER_* credentials skip the form", async () => {
    const f = factory();
    gate(f, { VITE_VOLLEY_BROKER_USERNAME: "desk", VITE_VOLLEY_BROKER_PASSWORD: "dev" });
    await flush();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(f.calls.at(-1)?.auth).toEqual({ username: "desk", password: "dev" });
  });

  it("demo mode never asks", () => {
    render(
      <SignInGate demo>
        <Probe />
      </SignInGate>,
    );
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.getByTestId("desk")).toHaveTextContent("demo:");
  });
});

describe("DeskStoreProvider auth refusal on a later reconnect", () => {
  it("reports it once, and stops the refused client reconnecting", async () => {
    const f = factory();
    const failed = vi.fn();
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://broker.test:9001"
        auth={{ username: "desk", password: "old" }}
        clientFactory={f.make}
        onAuthFailed={failed}
      >
        <Probe />
      </DeskStoreProvider>,
    );
    await flush();
    expect(screen.getByTestId("desk")).toHaveTextContent("connected:desk");
    act(() => {
      f.error(new AuthFailedError("Connection refused: Not authorized"));
      f.error(new AuthFailedError("Connection refused: Not authorized"));
    });
    await flush();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith("Connection refused: Not authorized");
    // mqtt.js would otherwise keep retrying the bad credentials every reconnectPeriod.
    expect(f.disconnects()).toBe(1);
    expect(screen.getByTestId("desk")).toHaveTextContent("disconnected:desk");
  });
});
