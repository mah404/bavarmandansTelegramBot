import { randomBytes } from "node:crypto";

export type ModerationSnapshot = {
  users: [number, string][];
  restrictions: [number, number | null][];
};

export function createModerationStore(now = Date.now) {
  const restrictions = new Map<number, number | null>();
  const codes = new Map<number, string>();
  const users = new Map<string, number>();

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
      return { users: Array.from(codes), restrictions: Array.from(restrictions) };
    },
    restore(data: ModerationSnapshot) {
      const validId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
      if (!Array.isArray(data.users) || !Array.isArray(data.restrictions)
        || data.users.some(([id, code]) => !validId(id) || typeof code !== "string" || !/^U-[A-F0-9]{12}$/.test(code))
        || new Set(data.users.map(([id]) => id)).size !== data.users.length
        || new Set(data.users.map(([, code]) => code)).size !== data.users.length
        || data.restrictions.some(([id, until]) => !validId(id) || !data.users.some(([uid]) => uid === id)
          || (until !== null && (typeof until !== "number" || !Number.isFinite(until))))) {
        throw new Error("Invalid moderation snapshot");
      }
      codes.clear();
      users.clear();
      restrictions.clear();
      for (const [id, code] of data.users) { codes.set(id, code); users.set(code, id); }
      for (const [id, until] of data.restrictions) restrictions.set(id, until);
    },
    codeFor,
    userFor: (code: string) => users.get(code.toUpperCase()),
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
        return until === undefined ? [] : [{ code: codeFor(userId), until }];
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
