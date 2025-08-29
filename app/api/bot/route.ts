// Next.js / Vercel-friendly webhook handler using grammy

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import { Bot, webhookCallback, Keyboard, InlineKeyboard, Composer } from "grammy";
import { type NextRequest } from "next/server";

/* ─────────────────────  ENV & BOT  ───────────────────── */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable not found.");

const bot = new Bot(token);

// ⚠️ Admin group/supergroup chat id (string form, keep the minus):
// const TARGET_CHANNEL = "-1002874971287";
const TARGET_CHANNEL = "-1002825832693";

/* ─────────────────────  STATE  ───────────────────── */
type UserState = "awaiting_file" | "awaiting_text" | "awaiting_anonymous_text";

const userStates = new Map<number, UserState>();      // per-user flow state (only for private chats)
const messageMap = new Map<number, number>();         // groupMessageId -> userId (for admin replies)

/* ─────────────────────  UI  ───────────────────── */
const mainKeyboard = new Keyboard()
  .text("📄 ارسال فایل پی‌دی‌اف")
  .text("💬 ارسال پیام")
  .row()
  .text("🔒 ارسال پیام به صورت ناشناس")
  .row()
  .text("ℹ️ درباره ما")
  .text("🌐 لینک سایت")
  .resized()
  .persistent(true)
  .placeholder("یکی از گزینه‌ها را انتخاب کنید…");

const MENU_TEXTS = new Set([
  "📄 ارسال فایل پی‌دی‌اف",
  "💬 ارسال پیام",
  "🔒 ارسال پیام به صورت ناشناس",
  "ℹ️ درباره ما",
  "🌐 لینک سایت",
]);

/* ─────────────────────  ROUTING BY CHAT  ───────────────────── */
const adminGroup = new Composer();   // messages from the admin group/supergroup
const privateChat = new Composer();  // messages from private (user) chats

bot.use((ctx, next) => {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return next();

  if (chatId === TARGET_CHANNEL) {
    // Admin group
    return adminGroup.middleware()(ctx, next);
  }

  if (ctx.chat?.type === "private") {
    // Private DMs with users
    return privateChat.middleware()(ctx, next);
  }

  // Any other chat types (other groups, channels) → ignore
  return;
});

/* ─────────────────────  /start (private only)  ───────────────────── */
bot.command("start", async (ctx) => {
  if (ctx.chat?.type !== "private") return; // ignore /start outside private chats

  await ctx.reply(
    `با عرض سلام مجدد،

جهت برقراری ارتباط یکی از گزینه‌های موجود را انتخاب نمایید. 

با تشکر`,
    { reply_markup: mainKeyboard }
  );
});

/* ─────────────────────  ADMIN GROUP LOGIC  ─────────────────────
   - Only handle replies to messages that the bot posted (forwarded/sent).
   - Ignore all non-reply chatter in the group.
------------------------------------------------------------------ */
adminGroup.on("message:text", async (ctx) => {
  const replied = ctx.message.reply_to_message;
  if (!replied) return; // ignore normal chatter

  const uid = messageMap.get(replied.message_id);
  if (!uid) return; // not a tracked bot message

  try {
    await ctx.api.sendMessage(uid, `پاسخ ادمین:\n${ctx.message.text}`);
    await ctx.reply("پاسخ برای کاربر ارسال شد ✅", {
      reply_to_message_id: ctx.message.message_id,
    });
  } catch {
    await ctx.reply("❌ خطا در ارسال پاسخ به کاربر.");
  }
});

// Ignore any other message types in admin group (stickers, photos, etc.)
adminGroup.on("message", () => {
  /* no-op */
});

/* ─────────────────────  PRIVATE CHAT LOGIC  ───────────────────── */
// Menu navigation & states
privateChat.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const state = userStates.get(ctx.from.id);

  /* ────── Menu entries (the only way to set a state) ────── */
  if (MENU_TEXTS.has(text)) {
    if (text === "📄 ارسال فایل پی‌دی‌اف") {
      userStates.set(ctx.from.id, "awaiting_file");
      return ctx.reply("لطفاً فایل PDF خود را ارسال کنید.", { reply_markup: mainKeyboard });
    }
    if (text === "💬 ارسال پیام") {
      userStates.set(ctx.from.id, "awaiting_text");
      return ctx.reply("پیام خود را وارد نمایید.", { reply_markup: mainKeyboard });
    }
    if (text === "🔒 ارسال پیام به صورت ناشناس") {
      userStates.set(ctx.from.id, "awaiting_anonymous_text");
      return ctx.reply("پیام ناشناس خود را وارد نمایید.", { reply_markup: mainKeyboard });
    }
    if (text === "ℹ️ درباره ما") {
      return ctx.reply(
        "این پیام‌رسان جهت ارتباط مستقیم با مدیران مجموعه تهیه گردیده است. پیشاپیش از حسن استفاده شما قدردانی می‌نماییم.",
        { reply_markup: mainKeyboard }
      );
    }
    if (text === "🌐 لینک سایت") {
      const ik = new InlineKeyboard().url("ورود به سایت", "https://www.bavarmandan.com/");
      return ctx.reply("برای بازدید از سایت ما کلیک کنید:", { reply_markup: ik });
    }
  }

  /* ────── If no state was chosen yet, nudge user to pick a menu item ────── */
  if (!state) {
    return ctx.reply("🚨 لطفاً ابتدا یکی از گزینه‌ها را از منوی زیر انتخاب کنید.", {
      reply_markup: mainKeyboard,
    });
  }

  /* ────── State-based processing ────── */

  // 1) Expecting a normal text message (with identity)
  if (state === "awaiting_text") {
    // safety: in this handler we're already in message:text
    try {
      const displayName = ctx.from.first_name ?? "کاربر";
      const username = ctx.from.username ? `@${ctx.from.username}` : "بدون‌نام کاربری";
      const sent = await ctx.api.sendMessage(
        TARGET_CHANNEL,
        `پیام از ${displayName} (${username}):\n${ctx.message.text}`
      );
      messageMap.set(sent.message_id, ctx.from.id);
      await ctx.reply("پیام شما ارسال گردید.", { reply_markup: mainKeyboard });
      userStates.delete(ctx.from.id);
    } catch {
      await ctx.reply("❌ خطا در ارسال پیام. دوباره تلاش کنید.", { reply_markup: mainKeyboard });
      // keep state so they can retry
    }
    return;
  }

  // 2) Expecting an anonymous text message
  if (state === "awaiting_anonymous_text") {
    try {
      const sent = await ctx.api.sendMessage(TARGET_CHANNEL, `پیام ناشناس:\n${ctx.message.text}`);
      messageMap.set(sent.message_id, ctx.from.id);
      await ctx.reply("پیام ناشناس شما ارسال گردید.", { reply_markup: mainKeyboard });
      userStates.delete(ctx.from.id);
    } catch {
      await ctx.reply("❌ خطا در ارسال پیام ناشناس. دوباره تلاش کنید.", {
        reply_markup: mainKeyboard,
      });
      // keep state
    }
    return;
  }

  // 3) If state is awaiting_file but user typed text, remind them
  if (state === "awaiting_file") {
    return ctx.reply("تنها فایل PDF مجاز است. لطفاً فایل خود را ارسال کنید.", {
      reply_markup: mainKeyboard,
    });
  }
});

// Receiving files/photos/etc. in private chat
privateChat.on("message", async (ctx, next) => {
  const state = userStates.get(ctx.from.id);

  // If no state set yet, only nudge once for any non-menu input
  if (!state && ctx.chat.type === "private") {
    await ctx.reply("برای شروع، یکی از گزینه‌ها را از منو انتخاب کنید.", {
      reply_markup: mainKeyboard,
    });
    return;
  }

  // Handle the PDF upload state
  if (state === "awaiting_file") {
    const doc = ctx.message?.document;
    if (doc?.mime_type === "application/pdf") {
      try {
        const sent = await ctx.api.forwardMessage(
          TARGET_CHANNEL,
          ctx.chat.id,
          ctx.message.message_id
        );
        messageMap.set(sent.message_id, ctx.from.id);
        await ctx.reply("فایل شما ارسال شد. متشکرم!", { reply_markup: mainKeyboard });
        userStates.delete(ctx.from.id); // clear after success
      } catch {
        await ctx.reply("❌ خطا در ارسال فایل. دوباره تلاش کنید.", { reply_markup: mainKeyboard });
        // keep state to retry
      }
      return;
    }

    // Not a PDF → ask again, keep state
    await ctx.reply("تنها فایل PDF مجاز است. لطفاً مجدداً امتحان کنید.", {
      reply_markup: mainKeyboard,
    });
    return;
  }

  // Let other privateChat handlers continue if needed
  return next();
});

/* ─────────────────────  WEBHOOK ENTRYPOINT  ───────────────────── */
export async function POST(req: NextRequest) {
  return webhookCallback(bot, "std/http")(req);
}
