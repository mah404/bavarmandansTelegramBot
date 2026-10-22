import { randomBytes } from "node:crypto";

export type ModerationSnapshot = {
  users: [number, string, string?][];
  restrictions: [number, number | null][];
  flows?: [number, string][];
};

const FLOW_PATTERN = /^(?:file|(?:topic|reply):(identified|anonymous)|message:(identified|anonymous):(?:feedback:none|question:(?:telegram|current_app)))$/;

export function createModerationStore(now = Date.now) {
  const restrictions = new Map<number, number | null>();
  const codes = new Map<number, string>();
  const users = new Map<string, number>();
  const labels = new Map<number, string>();
  const flows = new Map<number, string>();

  function codeFor(userId: number) {
    let code = codes.get(userId);
    if (!code) {
      do {
        code = `U-${randomBytes(6).toString("hex").toUpperCase()}`;
      } while (users.has(code));
      codes.set(userId, code);
      users.set(code, userId);
    }
    return code;
  }

  function status(userId: number) {
    const until = restrictions.get(userId);
    if (until !== undefined && until !== null && until <= now()) {
      restrictions.delete(userId);
      return undefined;
    }
    return until;
  }

  return {
    snapshot(): ModerationSnapshot {
      return { users: Array.from(codes, ([id, code]) => [id, code, labels.get(id)]), restrictions: Array.from(restrictions), flows: Array.from(flows) };
    },
    restore(data: ModerationSnapshot) {
      const validId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
      if (!Array.isArray(data.users) || !Array.isArray(data.restrictions)
        || data.users.some(([id, code, label]) => !validId(id) || typeof code !== "string" || !/^U-[A-F0-9]{12}$/.test(code)
          || (label != null && (typeof label !== "string" || !/^(?:@[A-Za-z0-9_]{1,32}|[0-9]+)$/.test(label))))
        || new Set(data.users.map(([id]) => id)).size !== data.users.length
        || new Set(data.users.map(([, code]) => code)).size !== data.users.length
        || data.restrictions.some(([id, until]) => !validId(id) || !data.users.some(([uid]) => uid === id)
          || (until !== null && (typeof until !== "number" || !Number.isFinite(until))))
        || (data.flows !== undefined && (!Array.isArray(data.flows)
          || data.flows.some(([id, flow]) => !validId(id) || !data.users.some(([uid]) => uid === id)
            || typeof flow !== "string" || !FLOW_PATTERN.test(flow))))) {
        throw new Error("Invalid moderation snapshot");
      }
      codes.clear();
      users.clear();
      restrictions.clear();
      labels.clear();
      flows.clear();
      for (const [id, code, label] of data.users) {
        codes.set(id, code); users.set(code, id);
        if (label) labels.set(id, label);
      }
      for (const [id, until] of data.restrictions) restrictions.set(id, until);
      for (const [id, flow] of data.flows ?? []) flows.set(id, flow);
    },
    flowFor: (userId: number) => flows.get(userId),
    setFlow(userId: number, flow?: string) {
      if (flow === undefined) { flows.delete(userId); return; }
      if (!FLOW_PATTERN.test(flow)) throw new Error("Invalid conversation flow");
      codeFor(userId);
      flows.set(userId, flow);
    },
    codeFor,
    labelFor(userId: number) {
      return labels.get(userId) ?? `#${codeFor(userId).replace("-", "_")}`;
    },
    setDisplay(userId: number, identified: boolean, username?: string) {
      codeFor(userId);
      if (identified) labels.set(userId, username ? `@${username}` : String(userId));
      else labels.delete(userId);
    },
    userFor(value: string) {
      const byCode = users.get(value.replace(/^#?U_/i, "U-").toUpperCase());
      if (byCode) return byCode;
      return Array.from(labels).find(([, label]) => label.toLowerCase() === value.toLowerCase())?.[0];
    },
    status,
    block(userId: number) {
      codeFor(userId);
      restrictions.set(userId, null);
    },
    ban1h(userId: number) {
      codeFor(userId);
      restrictions.set(userId, now() + 3_600_000);
    },
    unblock: (userId: number) => restrictions.delete(userId),
    list() {
      return Array.from(restrictions.keys()).flatMap((userId) => {
        const until = status(userId);
        return until === undefined ? [] : [{ code: codeFor(userId), label: labels.get(userId) ?? `#${codeFor(userId).replace("-", "_")}`, until }];
      });
    },
  };
}

export function formatRemaining(until: number) {
  const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}
