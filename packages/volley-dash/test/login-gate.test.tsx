/**
 * LoginGate — the dashboard asks for broker credentials before it connects,
 * keeps them in localStorage, and drops back to the form when the broker
 * refuses them (CONNACK "bad username or password" / "not authorized").
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CREDENTIALS_STORAGE_KEY, LoginGate } from "../src/components/LoginGate";
import {
  AuthFailedError,
  type BrokerCredentials,
  type VolleyMqttClient,
} from "../src/lib/mqtt-client";

function mockClient(connect: () => Promise<void>): VolleyMqttClient {
  return {
    connect,
    disconnect: async () => {},
    onMessage: () => () => {},
    onConnect: () => () => {},
    onDisconnect: () => () => {},
    onError: () => () => {},
  };
}

describe("LoginGate", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("with no stored credentials, shows the login form and does not connect", () => {
    const factory = vi.fn();
    render(<LoginGate brokerUrl="ws://localhost:9001" clientFactory={factory} />);
    expect(screen.getByTestId("login-form")).toBeInTheDocument();
    expect(screen.getByText("ws://localhost:9001")).toBeInTheDocument();
    expect(factory).not.toHaveBeenCalled();
  });

  it("with stored credentials, connects with that username/password", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "desk", password: "s3cret" }),
    );
    const factory = vi.fn((_url: string, _auth?: BrokerCredentials) => mockClient(async () => {}));
    await act(async () => {
      render(<LoginGate brokerUrl="ws://localhost:9001" clientFactory={factory} />);
    });
    expect(factory).toHaveBeenCalledWith("ws://localhost:9001", {
      username: "desk",
      password: "s3cret",
    });
    expect(screen.queryByTestId("login-form")).not.toBeInTheDocument();
  });

  it("submitting the form stores the credentials and connects with them", async () => {
    const factory = vi.fn((_url: string, _auth?: BrokerCredentials) => mockClient(async () => {}));
    render(<LoginGate brokerUrl="ws://localhost:9001" clientFactory={factory} />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "desk" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("login-form"));
    });
    expect(factory).toHaveBeenCalledWith("ws://localhost:9001", {
      username: "desk",
      password: "pw",
    });
    expect(JSON.parse(localStorage.getItem(CREDENTIALS_STORAGE_KEY) ?? "null")).toEqual({
      username: "desk",
      password: "pw",
    });
  });

  it("an empty username connects anonymously (for brokers that still allow it)", async () => {
    const factory = vi.fn((_url: string, _auth?: BrokerCredentials) => mockClient(async () => {}));
    render(<LoginGate brokerUrl="ws://localhost:9001" clientFactory={factory} />);
    await act(async () => {
      fireEvent.submit(screen.getByTestId("login-form"));
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("AUTH_FAILED shows the form again with the error and forgets the password", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "desk", password: "stale" }),
    );
    const factory = vi.fn((_url: string, _auth?: BrokerCredentials) =>
      mockClient(async () => {
        throw new AuthFailedError("Connection refused: Bad username or password");
      }),
    );
    await act(async () => {
      render(<LoginGate brokerUrl="ws://localhost:9001" clientFactory={factory} />);
    });
    expect(screen.getByTestId("login-form")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Bad username or password");
    expect(screen.getByLabelText("Username")).toHaveValue("desk");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(localStorage.getItem(CREDENTIALS_STORAGE_KEY)).toBeNull();
  });

  it("a non-auth connect failure keeps the dashboard (it shows the broker as disconnected)", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "desk", password: "pw" }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const factory = vi.fn((_url: string, _auth?: BrokerCredentials) =>
      mockClient(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    await act(async () => {
      render(<LoginGate brokerUrl="ws://localhost:9001" clientFactory={factory} />);
    });
    expect(screen.queryByTestId("login-form")).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it("ignores a corrupted stored entry", () => {
    localStorage.setItem(CREDENTIALS_STORAGE_KEY, "{not json");
    render(<LoginGate brokerUrl="ws://localhost:9001" clientFactory={vi.fn()} />);
    expect(screen.getByTestId("login-form")).toBeInTheDocument();
  });
});
