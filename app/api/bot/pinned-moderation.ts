import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { Api } from "grammy";
import type { createModerationStore, ModerationSnapshot } from "./moderation";

const MARKER = "BOT_MODERATION_V1:";
const GUIDE = `راهنمای مدیریت کاربران 📋
/block — بلاک دائمی
/unblock — رفع محدودیت
/ban1h — بن یک‌ساعته
/blockList — نمایش و به‌روزرسانی فهرست

روی پیام کاربر ریپلای کنید یا شناسه را بعد از دستور بنویسید.
این پیام را حذف یا از پین خارج نکنید؛ پیام جدیدتری را پین نکنید.
زمان‌های پایان بن به وقت UTC هستند.
`;

export function createPinnedModeration(
  api: Api,
  chatId: string,
  secret: string,
  store: ReturnType<typeof createModerationStore>,
  botId: () => number
) {
  // Bind authentication to this group, so copied snapshots are not trusted elsewhere.
  const key = createHash("sha256").update(`moderation:${chatId}:${secret}`).digest();
  let messageId: number | undefined;
  let saved = "";
  let queue: Promise<unknown> = Promise.resolve();

  function encrypt(data: ModerationSnapshot) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(deflateSync(JSON.stringify(data))), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  function decrypt(value: string): ModerationSnapshot {
    const data = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    const clear = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    return JSON.parse(inflateSync(clear, { maxOutputLength: 100_000 }).toString("utf8"));
  }

  function render() {
    const entries = store.list();
    const lines = entries.map(({ label, until }) => until === null
      ? `${label} — دائمی 🚫` : `${label} — تا ${new Date(until).toISOString()} ⏳`);
    const text = `${GUIDE}\nمحدودیت‌های فعال:\n${lines.join("\n") || "فهرست خالی است. ✅"}\n\nاطلاعات بازیابی رمزگذاری‌شده؛ تغییر ندهید:\n${MARKER}${encrypt(store.snapshot())}`;
    if (text.length > 4000) throw new Error("Pinned moderation capacity exceeded");
    return text;
  }

  async function load(initialize: boolean) {
    const chat = await api.getChat(chatId);
    const pinned = chat.pinned_message;
    if (!pinned) {
      if (messageId) throw new Error("Moderation pin missing");
      if (!initialize) throw new Error("Initialize moderation with /blockList in the support group");
      const created = await api.sendMessage(chatId, render());
      await api.pinChatMessage(chatId, created.message_id, { disable_notification: true });
      messageId = created.message_id;
      saved = JSON.stringify(store.snapshot());
      return;
    }
    if (pinned.from?.id !== botId() || !pinned.text?.includes(MARKER)) {
      throw new Error("The moderation message must be the newest pinned message");
    }
    const encrypted = pinned.text.split(MARKER)[1]?.trim();
    if (!encrypted) throw new Error("Missing moderation snapshot");
    store.restore(decrypt(encrypted));
    messageId = pinned.message_id;
    saved = JSON.stringify(store.snapshot());
  }

  async function save(force = false) {
    if (!messageId) throw new Error("Moderation not initialized");
    const previous = saved;
    try {
      const text = render();
      const current = JSON.stringify(store.snapshot());
      if (current === saved && !force) return;
      await api.editMessageText(chatId, messageId, text);
      saved = current;
    } catch (error) {
      if (previous) store.restore(JSON.parse(previous));
      throw error;
    }
  }

  return {
    save,
    // Serializes updates handled by this process; Telegram has no cross-process CAS.
    run<T>(initialize: boolean, action: () => Promise<T>): Promise<T> {
      const task = queue.then(async () => { await load(initialize); return action(); });
      queue = task.catch(() => undefined);
      return task;
    },
  };
}
