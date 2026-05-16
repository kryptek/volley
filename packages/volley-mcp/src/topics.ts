/** Agent id / namespace grammar (SPEC.md §2.1, §2.2). */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isValidAgentId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isValidNamespace(ns: string): boolean {
  return ID_PATTERN.test(ns);
}

/** Build a canonical Volley topic. Callers validate inputs first. */
export function buildTopic(namespace: string, agentId: string, channel: string): string {
  return `volley/${namespace}/${agentId}/${channel}`;
}

/** The retained registry topic for an agent (SPEC.md §6.1). */
export function registryTopic(agentId: string): string {
  return `volley/_system/registry/${agentId}`;
}

/** True if a topic targets a reserved namespace (SPEC.md §2.4) — must not be written from user space. */
export function isReservedTopic(topic: string): boolean {
  return topic.startsWith("volley/_system/") || topic.startsWith("volley/_meta/");
}

/** Basic MQTT topic-filter validation: non-empty, no spaces, wildcards used legally. */
export function isValidTopicFilter(filter: string): boolean {
  if (filter.length === 0 || filter.includes(" ")) return false;
  const levels = filter.split("/");
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i] ?? "";
    if (level === "#" && i !== levels.length - 1) return false;
    if (level !== "#" && level !== "+" && (level.includes("#") || level.includes("+"))) {
      return false;
    }
  }
  return true;
}
