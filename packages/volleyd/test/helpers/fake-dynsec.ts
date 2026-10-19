import type { BrokerCredentials, CredentialStore } from "../../src/identity";

/**
 * The in-process mosquitto 2.1 + Dynamic Security stand-in (`$CONTROL` responder on Aedes:
 * command arrays, the plugin's error table, `%u` ACL matching, `$SYS/broker/version`). It
 * lives in volley-cli's tests, which bootstrap the roles volleyd relies on.
 */
export {
  type FakeDynsec,
  startFakeDynsec,
  topicMatches,
} from "volley-cli/test/fake-dynsec";

export interface MemoryCredentials extends CredentialStore {
  /** When each login was minted (tests age one by setting it). */
  readonly mintedAt: Map<string, number>;
  /** Every mint, in order. */
  minted: string[];
  /** Every revoke, in order. */
  revoked: string[];
  /** The logins that exist now. */
  logins: Set<string>;
  /** Make the next mint of `agentId` (or any, with no id) fail. */
  failNextMint: (agentId?: string) => void;
}

/** An in-memory credential store for spawn and daemon tests (no broker involved). */
export function memoryCredentials(now: () => number = Date.now): MemoryCredentials {
  const mintedAt = new Map<string, number>();
  const fails: (string | undefined)[] = [];
  const store: MemoryCredentials = {
    minted: [],
    revoked: [],
    logins: new Set(),
    mintedAt,
    failNextMint: (id) => fails.push(id),
    mint: async (agentId): Promise<BrokerCredentials> => {
      const i = fails.findIndex((f) => f === undefined || f === agentId);
      if (i !== -1) {
        fails.splice(i, 1);
        throw new Error("createClient: Internal error");
      }
      store.minted.push(agentId);
      store.logins.add(agentId);
      mintedAt.set(agentId, now());
      return { username: agentId, password: `pw-${agentId}` };
    },
    revoke: async (agentId) => {
      store.revoked.push(agentId);
      store.logins.delete(agentId);
      mintedAt.delete(agentId);
      return true;
    },
    agentLogins: async () => [...store.logins].sort(),
  };
  return store;
}
