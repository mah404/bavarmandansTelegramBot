// Next.js / Vercel-friendly webhook handler using grammy

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import { Bot, webhookCallback, Keyboard, InlineKeyboard, Composer } from "grammy";
import { type NextRequest } from "next/server";

/* ─────────────────────  ENV & BOT  ───────────────────── */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable not found.");

const bot = new Bot(token);

// const TARGET_CHANNEL = "-1002874971287"; this i sthe test
const TARGET_CHANNEL = "-1002825832693";

/* ─────────────────────  STATE  ───────────────────── */
type MessageMode = "identified" | "anonymous";
type MessageTopic = "question" | "feedback";
type ReplyPreference = "telegram" | "current_app";

type UserState =
  | { step: "awaiting_file" }
  | { step: "awaiting_topic"; mode: MessageMode }
  | { step: "awaiting_reply_preference"; mode: MessageMode; topic: "question" }
  | {
      step: "awaiting_message";
      mode: MessageMode;
      topic: MessageTopic;
      replyPreference?: ReplyPreference;
    };

const userStates = new Map<number, UserState>();      // per-user flow state (only for private chats)
const messageMap = new Map<number, number>();         // groupMessageId -> userId (for admin replies)

/* ─────────────────────  UI  ───────────────────── */
const MENU_IDENTIFIED_MESSAGE = "💬 ارسال پیام به صورت شناس";
const MENU_ANONYMOUS_MESSAGE = "🔒 ارسال پیام به صورت ناشناس";
const MENU_PDF = "📄 ارسال فایل پی‌دی‌اف";
const MENU_ABOUT = "ℹ️ درباره ما";
const MENU_WEBSITE = "🌐 لینک سایت";

const TOPIC_QUESTION = "طرح سوال";
const TOPIC_FEEDBACK = "انتقادات و پیشنهادات";

const REPLY_TELEGRAM = "> در تلگرام هستم";
const REPLY_CURRENT_APP = "> در برنامه جاری";
const START_TEXT = `با عرض سلام مجدد،

جهت برقراری ارتباط یکی از گزینه‌های موجود را انتخاب نمایید. 

با تشکر`;

const mainKeyboard = new Keyboard()
  .text(MENU_IDENTIFIED_MESSAGE)
  .row()
  .text(MENU_ANONYMOUS_MESSAGE)
  .row()
  .text(MENU_PDF)
  .row()
  .text(MENU_WEBSITE)
  .text(MENU_ABOUT)
  .resized()
  .persistent(true)
  .placeholder("یکی از گزینه‌ها را انتخاب کنید…");

const topicKeyboard = new Keyboard()
  .text(TOPIC_QUESTION)
  .text(TOPIC_FEEDBACK)
  .resized()
  .persistent(true)
  .placeholder("یکی از گزینه‌های زیر را انتخاب نمایید");

const replyPreferenceKeyboard = new Keyboard()
  .text(REPLY_TELEGRAM)
  .text(REPLY_CURRENT_APP)
  .resized()
  .persistent(true)
  .placeholder("مایل به دریافت پاسخ؟");

const removeKeyboard = { remove_keyboard: true } as const;

function topicInlineKeyboard(mode: MessageMode) {
  return new InlineKeyboard()
    .text(TOPIC_QUESTION, `topic:${mode}:question`)
    .text(TOPIC_FEEDBACK, `topic:${mode}:feedback`);
}

function replyPreferenceInlineKeyboard(mode: MessageMode) {
  return new InlineKeyboard()
    .text("در تلگرام هستم", `reply:${mode}:telegram`)
    .text("در برنامه جاری", `reply:${mode}:current_app`);
}

function forceReplyMarkup(placeholder: string) {
  return {
    force_reply: true,
    selective: true,
    input_field_placeholder: placeholder,
  } as const;
}

const MENU_TEXTS = new Set([
  MENU_IDENTIFIED_MESSAGE,
  MENU_ANONYMOUS_MESSAGE,
  MENU_PDF,
  MENU_ABOUT,
  MENU_WEBSITE,
]);

function normalizeChoice(text: string) {
  return text
    .replace(/[>\u200c\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTopic(text: string): MessageTopic | undefined {
  const normalized = normalizeChoice(text);
  if (normalized === "طرح سوال" || normalized === "سوال") return "question";
  if (normalized === TOPIC_FEEDBACK) return "feedback";
  return undefined;
}

function parseReplyPreference(text: string): ReplyPreference | undefined {
  const normalized = normalizeChoice(text);
  if (normalized === "در تلگرام هستم" || normalized.includes("تلگرام")) return "telegram";
  if (normalized === "در برنامه جاری" || normalized.includes("برنامه جاری")) return "current_app";
  return undefined;
}

function getModeLabel(mode: MessageMode) {
  return mode === "identified" ? "شناس" : "ناشناس";
}

function getTopicLabel(topic: MessageTopic) {
  return topic === "question" ? TOPIC_QUESTION : TOPIC_FEEDBACK;
}

function getReplyPreferenceLabel(replyPreference?: ReplyPreference) {
  if (replyPreference === "telegram") return "در تلگرام هستم";
  if (replyPreference === "current_app") return "در برنامه جاری";
  return "ثبت نشده";
}

function buildGroupMessage(
  state: Extract<UserState, { step: "awaiting_message" }>,
  text: string,
  from: { first_name?: string; username?: string; id: number }
) {
  const displayName = from.first_name ?? "کاربر";
  const username = from.username ? `@${from.username}` : "بدون‌نام کاربری";
  const identityLine =
    state.mode === "identified"
      ? `فرستنده: ${displayName} (${username})`
      : "فرستنده: ناشناس";

  const replyLine =
    state.topic === "question"
      ? `مایل به دریافت پاسخ: ${getReplyPreferenceLabel(state.replyPreference)}`
      : undefined;

  return [
    `نوع ارسال: ${getModeLabel(state.mode)}`,
    `موضوع: ${getTopicLabel(state.topic)}`,
    replyLine,
    identityLine,
    "",
    "متن پیام:",
    text,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFinalPrompt(state: Extract<UserState, { step: "awaiting_message" }>) {
  const replyLine =
    state.topic === "question"
      ? `مایل به دریافت پاسخ: ${getReplyPreferenceLabel(state.replyPreference)}`
      : undefined;

  return [
    state.topic === "feedback"
      ? `پیام ${getModeLabel(state.mode)} خود را وارد نمایید.`
      : "پیام خود را وارد نمایید.",
    "",
    "اطلاعات انتخاب‌شده:",
    `نوع ارسال: ${getModeLabel(state.mode)}`,
    `موضوع: ${getTopicLabel(state.topic)}`,
    replyLine,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseFinalPrompt(text?: string): Extract<UserState, { step: "awaiting_message" }> | undefined {
  if (!text?.includes("اطلاعات انتخاب‌شده:")) return undefined;

  const mode = text.includes("نوع ارسال: ناشناس") ? "anonymous" : "identified";
  const topic = text.includes(`موضوع: ${TOPIC_FEEDBACK}`) ? "feedback" : "question";
  const replyPreference = parseReplyPreference(text);

  return {
    step: "awaiting_message",
    mode,
    topic,
    replyPreference,
  };
}

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
  if (!ctx.from) return;

  userStates.delete(ctx.from.id);
  await ctx.reply(START_TEXT, { reply_markup: mainKeyboard });
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
privateChat.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [kind, mode, value] = data.split(":") as [
    string,
    MessageMode | undefined,
    string | undefined,
  ];

  if (mode !== "identified" && mode !== "anonymous") {
    await ctx.answerCallbackQuery();
    return;
  }

  if (kind === "topic") {
    if (value === "question") {
      userStates.set(ctx.from.id, {
        step: "awaiting_reply_preference",
        mode,
        topic: "question",
      });
      await ctx.answerCallbackQuery();
      await ctx.reply("مایل به دریافت پاسخ؟", {
        reply_markup: replyPreferenceInlineKeyboard(mode),
      });
      return;
    }

    if (value === "feedback") {
      const nextState: Extract<UserState, { step: "awaiting_message" }> = {
        step: "awaiting_message",
        mode,
        topic: "feedback",
      };
      userStates.set(ctx.from.id, nextState);
      await ctx.answerCallbackQuery();
      await ctx.reply(buildFinalPrompt(nextState), {
        reply_markup: forceReplyMarkup(`پیام ${getModeLabel(mode)} خود را وارد نمایید.`),
      });
      return;
    }
  }

  if (kind === "reply") {
    if (value !== "telegram" && value !== "current_app") {
      await ctx.answerCallbackQuery();
      return;
    }

    const nextState: Extract<UserState, { step: "awaiting_message" }> = {
      step: "awaiting_message",
      mode,
      topic: "question",
      replyPreference: value,
    };
    userStates.set(ctx.from.id, nextState);
    await ctx.answerCallbackQuery();
    await ctx.reply(buildFinalPrompt(nextState), {
      reply_markup: forceReplyMarkup("پیام خود را وارد نمایید."),
    });
    return;
  }

  await ctx.answerCallbackQuery();
});

// Menu navigation & states
privateChat.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const state = userStates.get(ctx.from.id);

  if (text === "/start") {
    userStates.delete(ctx.from.id);
    return ctx.reply(START_TEXT, { reply_markup: mainKeyboard });
  }

  const repliedPromptState = parseFinalPrompt(ctx.message.reply_to_message?.text);
  if (repliedPromptState) {
    try {
      const sent = await ctx.api.sendMessage(
        TARGET_CHANNEL,
        buildGroupMessage(repliedPromptState, ctx.message.text, ctx.from)
      );
      messageMap.set(sent.message_id, ctx.from.id);
      await ctx.reply("پیام شما ارسال گردید.", { reply_markup: mainKeyboard });
      userStates.delete(ctx.from.id);
    } catch {
      await ctx.reply("❌ خطا در ارسال پیام. دوباره تلاش کنید.", { reply_markup: mainKeyboard });
    }
    return;
  }

  /* ────── Menu entries (the only way to set a state) ────── */
  if (MENU_TEXTS.has(text)) {
    if (text === MENU_PDF) {
      userStates.set(ctx.from.id, { step: "awaiting_file" });
      return ctx.reply("لطفاً فایل PDF خود را ارسال کنید.", { reply_markup: mainKeyboard });
    }
    if (text === MENU_IDENTIFIED_MESSAGE) {
      userStates.delete(ctx.from.id);
      return ctx.reply("یکی از گزینه‌های زیر را انتخاب نمایید.", {
        reply_markup: topicInlineKeyboard("identified"),
      });
    }
    if (text === MENU_ANONYMOUS_MESSAGE) {
      userStates.delete(ctx.from.id);
      return ctx.reply("یکی از گزینه‌های زیر را انتخاب نمایید.", {
        reply_markup: topicInlineKeyboard("anonymous"),
      });
    }
    if (text === MENU_ABOUT) {
      userStates.delete(ctx.from.id);
      return ctx.reply(
        "این پیام‌رسان جهت ارتباط مستقیم با مدیران مجموعه تهیه گردیده است. پیشاپیش از حسن استفاده شما قدردانی می‌نماییم.",
        { reply_markup: mainKeyboard }
      );
    }
    if (text === MENU_WEBSITE) {
      userStates.delete(ctx.from.id);
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

  // 1) Expecting the user to choose question or feedback.
  if (state.step === "awaiting_topic") {
    const topic = parseTopic(text);

    if (topic === "question") {
      userStates.set(ctx.from.id, {
        step: "awaiting_reply_preference",
        mode: state.mode,
        topic: "question",
      });
      return ctx.reply("مایل به دریافت پاسخ؟", {
        reply_markup: replyPreferenceInlineKeyboard(state.mode),
      });
    }

    if (topic === "feedback") {
      const nextState: Extract<UserState, { step: "awaiting_message" }> = {
        step: "awaiting_message",
        mode: state.mode,
        topic: "feedback",
      };
      userStates.set(ctx.from.id, nextState);

      return ctx.reply(buildFinalPrompt(nextState), {
        reply_markup: forceReplyMarkup(`پیام ${getModeLabel(state.mode)} خود را وارد نمایید.`),
      });
    }

    return ctx.reply("لطفاً یکی از گزینه‌های زیر را انتخاب نمایید.", {
      reply_markup: topicKeyboard,
    });
  }

  // 2) Expecting how the user wants to receive a reply for a question.
  if (state.step === "awaiting_reply_preference") {
    const replyPreference = parseReplyPreference(text);

    if (!replyPreference) {
      return ctx.reply("لطفاً یکی از گزینه‌های زیر را انتخاب نمایید.", {
        reply_markup: replyPreferenceKeyboard,
      });
    }

    const nextState: Extract<UserState, { step: "awaiting_message" }> = {
      step: "awaiting_message",
      mode: state.mode,
      topic: state.topic,
      replyPreference,
    };
    userStates.set(ctx.from.id, nextState);

    return ctx.reply(buildFinalPrompt(nextState), {
      reply_markup: forceReplyMarkup("پیام خود را وارد نمایید."),
    });
  }

  // 3) Expecting the final message text.
  if (state.step === "awaiting_message") {
    try {
      const sent = await ctx.api.sendMessage(
        TARGET_CHANNEL,
        buildGroupMessage(state, ctx.message.text, ctx.from)
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

  // 4) If state is awaiting_file but user typed text, remind them
  if (state.step === "awaiting_file") {
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

  if (!state) return next();

  // Handle the PDF upload state
  if (state.step === "awaiting_file") {
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

  if (state.step === "awaiting_topic") {
    await ctx.reply("لطفاً یکی از گزینه‌های زیر را انتخاب نمایید.", {
      reply_markup: topicKeyboard,
    });
    return;
  }

  if (state.step === "awaiting_reply_preference") {
    await ctx.reply("لطفاً یکی از گزینه‌های زیر را انتخاب نمایید.", {
      reply_markup: replyPreferenceKeyboard,
    });
    return;
  }

  if (state.step === "awaiting_message") {
    await ctx.reply("لطفاً پیام خود را به صورت متن ارسال کنید.", {
      reply_markup: removeKeyboard,
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

