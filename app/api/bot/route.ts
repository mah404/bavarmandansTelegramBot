// Next.js / Vercel-friendly webhook handler using grammy

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import { Bot, webhookCallback, Keyboard, InlineKeyboard, Composer } from "grammy";
import { type NextRequest } from "next/server";
import { createModerationStore, formatRemaining } from "./moderation";
import { createPinnedModeration } from "./pinned-moderation";

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

const messageMap = new Map<number, number>();         // groupMessageId -> userId (for admin replies)
const moderation = createModerationStore();
const pinnedModeration = createPinnedModeration(bot.api, TARGET_CHANNEL, token, moderation, () => bot.botInfo.id);
const userStates = {
  get(id: number): UserState | undefined {
    const flow = moderation.flowFor(id);
    if (!flow) return undefined;
    if (flow === "file") return { step: "awaiting_file" };
    const [step, mode, topic, preference] = flow.split(":");
    if (mode !== "identified" && mode !== "anonymous") return undefined;
    if (step === "topic") return { step: "awaiting_topic", mode };
    if (step === "reply") return { step: "awaiting_reply_preference", mode, topic: "question" };
    if (step === "message" && topic === "feedback") return { step: "awaiting_message", mode, topic };
    if (step === "message" && topic === "question" && (preference === "telegram" || preference === "current_app")) {
      return { step: "awaiting_message", mode, topic, replyPreference: preference };
    }
    return undefined;
  },
  set(id: number, state: UserState) {
    const flow = state.step === "awaiting_file" ? "file"
      : state.step === "awaiting_topic" ? `topic:${state.mode}`
      : state.step === "awaiting_reply_preference" ? `reply:${state.mode}`
      : `message:${state.mode}:${state.topic}:${state.replyPreference ?? "none"}`;
    moderation.setFlow(id, flow);
  },
  delete(id: number) { moderation.setFlow(id); },
};

/* ─────────────────────  UI  ───────────────────── */
const MENU_IDENTIFIED_MESSAGE = "💬 ارسال پیام به صورت شناس";
const MENU_ANONYMOUS_MESSAGE = "🔒 ارسال پیام به صورت ناشناس";
const MENU_PDF = "📄 ارسال فایل پی‌دی‌اف";
const MENU_ABOUT = "ℹ️ درباره ما";
const MENU_WEBSITE = "🌐 لینک سایت";

const TOPIC_QUESTION = "طرح سوال";
const TOPIC_FEEDBACK = "انتقادات و پیشنهادات";

const START_TEXT = `با عرض سلام مجدد،

جهت برقراری ارتباط یکی از گزینه‌های موجود را انتخاب نمایید. ✨

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

const topicKeyboard = new Keyboard([
  [{ text: TOPIC_QUESTION }, { text: TOPIC_FEEDBACK }],
  ...mainKeyboard.build(),
]).resized().persistent(true);

const replyPreferenceKeyboard = new Keyboard([
  [{ text: "تلگرام" }, { text: "برنامه جاری" }],
  ...mainKeyboard.build(),
]).resized().persistent(true);

const SELECT_OPTION_TEXT = "یکی از گزینه‌های زیر را انتخاب نمایید. ▫️";
const ASK_REPLY_PREFERENCE_TEXT = "مایل به دریافت پاسخ در 📨";
const MESSAGE_SENT_TEXT = "پیام شما ارسال گردید. ✅";
const MESSAGE_SEND_ERROR_TEXT = "خطا در ارسال پیام. دوباره تلاش کنید. ⚠️";

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
  return mode === "identified" ? "👤 شناس" : "🔒 ناشناس";
}

function getTopicLabel(topic: MessageTopic) {
  return topic === "question" ? "❓ طرح سوال" : "🗣️ انتقادات و پیشنهادات";
}

function getReplyPreferenceLabel(replyPreference?: ReplyPreference) {
  if (replyPreference === "telegram") return "📲 در تلگرام هستم";
  if (replyPreference === "current_app") return "💬 در برنامه جاری";
  return "ثبت نشده";
}

function buildGroupMessage(
  state: Extract<UserState, { step: "awaiting_message" }>,
  text: string,
  from: { first_name?: string; username?: string; id: number }
) {
  moderation.setDisplay(from.id, state.mode === "identified", from.username);
  const displayName = from.first_name ?? "کاربر";
  const username = from.username ? `@${from.username}` : "بدون‌نام کاربری";
  const identityLine =
    state.mode === "identified"
      ? `فرستنده: ${displayName} (${username})`
      : "فرستنده: 🔒 ناشناس";

  const replyLine =
    state.topic === "question"
      ? `مایل به دریافت پاسخ: ${getReplyPreferenceLabel(state.replyPreference)}`
      : undefined;

  return [
    `نوع ارسال: ${getModeLabel(state.mode)}`,
    `موضوع پیام: ${getTopicLabel(state.topic)}`,
    replyLine,
    identityLine,
    `شناسه کاربر: ${moderation.labelFor(from.id)}`,
    "",
    "متن پیام:",
    text,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFinalPrompt() {
  return "پیام خود را وارد نمایید. 📝";
}

function parseFinalPrompt(
  text?: string,
  entities?: readonly { type: string; url?: string }[]
): Extract<UserState, { step: "awaiting_message" }> | undefined {
  for (const entity of entities ?? []) {
    if (entity.type !== "text_link" || !entity.url) continue;
    const url = new URL(entity.url);
    if (url.origin !== "https://t.me" || url.pathname !== `/${bot.botInfo.username}`) continue;
    const match = /^flow_(identified|anonymous)_(question|feedback)_(telegram|current_app|none)$/.exec(
      url.searchParams.get("start") ?? ""
    );
    if (!match) continue;
    const mode = match[1] as MessageMode;
    const topic = match[2] as MessageTopic;
    const replyPreference = match[3] === "none" ? undefined : match[3] as ReplyPreference;
    if (topic === "question" && !replyPreference) continue;
    return { step: "awaiting_message", mode, topic, replyPreference };
  }

  // Accept replies to prompts sent before the display change.
  if (!text?.includes("اطلاعات انتخاب‌شده:")) return undefined;

  const mode = text.includes("ناشناس") ? "anonymous" : "identified";
  const topic = text.includes(TOPIC_FEEDBACK) ? "feedback" : "question";
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
adminGroup.on("message:text", async (ctx, next) => {
  const isCommand = /^\/(block|unblock|ban1h|blocklist)(?:@\w+)?(?:\s|$)/i.test(ctx.message.text);
  if (!isCommand && !ctx.message.reply_to_message) return next();
  if (isCommand) {
    const senderChat = ctx.message.sender_chat;
    // Telegram identifies anonymous group administrators by the group itself.
    const anonymousGroupAdmin = senderChat?.id === ctx.chat.id
      && (ctx.chat.type === "group" || ctx.chat.type === "supergroup");
    if (senderChat && !anonymousGroupAdmin) {
      await ctx.reply("دستور را با حساب ادمین یا به نام خودِ همین گروه ارسال کنید. ⚠️");
      return;
    }
    if (!anonymousGroupAdmin) {
      if (!ctx.from) return;
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (member.status !== "creator" && member.status !== "administrator") {
        await ctx.reply("این دستور فقط برای ادمین‌های گروه فعال است. ⚠️");
        return;
      }
    }
  }
  try {
    await pinnedModeration.run(isCommand, next);
  } catch {
    await ctx.reply("خواندن یا ذخیره فهرست محدودیت‌ها انجام نشد. پیام مخصوص بات باید پین باشد و بات دسترسی پین داشته باشد. ممکن است ظرفیت پیام هم پر شده باشد. ⚠️");
  }
});

adminGroup.on("message:text", async (ctx) => {
  const replied = ctx.message.reply_to_message;
  const command = /^\/(block|unblock|ban1h|blocklist)(?:@(\w+))?(?:\s+(.*))?\s*$/i.exec(ctx.message.text);
  if (command) {
    if (command[2] && command[2].toLowerCase() !== ctx.me.username.toLowerCase()) return;
    const action = command[1].toLowerCase();
    if (action === "blocklist") {
      await pinnedModeration.save(true);
      const entries = moderation.list();
      if (!entries.length) {
        await ctx.reply("فهرست کاربران محدودشده خالی است. ✅");
        return;
      }
      // Keep each page comfortably below Telegram's message size limit.
      for (let offset = 0; offset < entries.length; offset += 40) {
        const lines = entries.slice(offset, offset + 40).map(({ label, until }) =>
          until === null ? `${label} — بلاک دائمی 🚫`
            : `${label} — بن موقت، باقی‌مانده: ${formatRemaining(until)} ⏳`
        );
        await ctx.reply(`فهرست کاربران محدودشده:\n${lines.join("\n")}`);
      }
      return;
    }

    const code = command[3]?.trim();
    const trustedReply = replied?.from?.id === ctx.me.id;
    const replyCode = trustedReply
      ? (replied.text ?? replied.caption ?? "").match(/شناسه کاربر: (\S+)/)?.[1]
      : undefined;
    const uid = code ? moderation.userFor(code)
      : trustedReply ? messageMap.get(replied.message_id) ?? (replyCode ? moderation.userFor(replyCode) : undefined)
      : undefined;
    if (!uid) {
      await ctx.reply("روی پیام ارسالی بات ریپلای کنید یا شناسه معتبر وارد کنید؛ مثال: /block U-123456ABCDEF ⚠️");
      return;
    }

    let notification: string;
    let confirmation: string;
    if (action === "block") {
      moderation.block(uid);
      notification = "امکان ارسال پیام شما به بات مسدود شده است. 🚫";
      confirmation = "بلاک دائمی شد. 🚫";
    } else if (action === "ban1h") {
      moderation.ban1h(uid);
      notification = "امکان ارسال پیام شما به بات به مدت یک ساعت محدود شده است. پس از این مدت محدودیت خودکار رفع می‌شود. ⏳";
      confirmation = "به مدت یک ساعت محدود شد. ⏳";
    } else {
      moderation.unblock(uid);
      notification = "محدودیت ارسال پیام شما برطرف شد. برای شروع /start را بزنید. ✅";
      confirmation = "از محدودیت خارج شد. ✅";
    }
    userStates.delete(uid);
    await pinnedModeration.save();
    let notified = true;
    try {
      await ctx.api.sendMessage(uid, notification);
    } catch {
      notified = false;
    }
    await ctx.reply(`${moderation.labelFor(uid)} ${confirmation}${notified ? "\nکاربر مطلع شد." : "\nارسال اعلان به کاربر ناموفق بود. ⚠️"}`);
    return;
  }
  if (!replied) return; // ignore normal chatter

  const replyCode = replied.from?.id === ctx.me.id
    ? (replied.text ?? replied.caption ?? "").match(/شناسه کاربر: (\S+)/)?.[1]
    : undefined;
  const uid = messageMap.get(replied.message_id) ?? (replyCode ? moderation.userFor(replyCode) : undefined);
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
privateChat.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try {
    await pinnedModeration.run(false, async () => {
      moderation.codeFor(ctx.from!.id);
      await pinnedModeration.save();
      await next();
      await pinnedModeration.save();
    });
  } catch {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "دسترسی موقتاً برقرار نیست. لطفاً کمی بعد تلاش کنید. ⚠️", show_alert: true });
    else await ctx.reply("دسترسی موقتاً برقرار نیست. لطفاً کمی بعد تلاش کنید. ⚠️");
  }
});

privateChat.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const until = moderation.status(ctx.from.id);
  if (until === undefined) return next();
  const text = until === null
    ? "امکان ارسال پیام شما به بات مسدود است. 🚫"
    : `امکان ارسال پیام شما موقتاً محدود است. زمان باقی‌مانده: ${formatRemaining(until)} ⏳`;
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text, show_alert: true });
  else await ctx.reply(text);
});

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
      await ctx.reply(ASK_REPLY_PREFERENCE_TEXT, {
        reply_markup: replyPreferenceKeyboard,
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
      await pinnedModeration.save();
      await ctx.reply(buildFinalPrompt(), {
        reply_markup: mainKeyboard,
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
    await pinnedModeration.save();
    await ctx.reply(buildFinalPrompt(), {
      reply_markup: mainKeyboard,
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

  const replied = ctx.message.reply_to_message;
  const repliedPromptState = replied?.from?.id === ctx.me.id
    ? parseFinalPrompt(replied.text, replied.entities)
    : undefined;
  if (repliedPromptState && !state && !MENU_TEXTS.has(text)) {
    try {
      const groupText = buildGroupMessage(repliedPromptState, ctx.message.text, ctx.from);
      await pinnedModeration.save();
      const sent = await ctx.api.sendMessage(
        TARGET_CHANNEL,
        groupText
      );
      messageMap.set(sent.message_id, ctx.from.id);
      await ctx.reply(MESSAGE_SENT_TEXT, { reply_markup: mainKeyboard });
      userStates.delete(ctx.from.id);
    } catch {
      await ctx.reply(MESSAGE_SEND_ERROR_TEXT, { reply_markup: mainKeyboard });
    }
    return;
  }

  /* ────── Menu entries (the only way to set a state) ────── */
  if (MENU_TEXTS.has(text)) {
    if (text === MENU_PDF) {
      userStates.set(ctx.from.id, { step: "awaiting_file" });
      return ctx.reply("لطفاً فایل PDF خود را ارسال کنید. 📄", { reply_markup: mainKeyboard });
    }
    if (text === MENU_IDENTIFIED_MESSAGE) {
      userStates.set(ctx.from.id, { step: "awaiting_topic", mode: "identified" });
      return ctx.reply(SELECT_OPTION_TEXT, {
        reply_markup: topicKeyboard,
      });
    }
    if (text === MENU_ANONYMOUS_MESSAGE) {
      userStates.set(ctx.from.id, { step: "awaiting_topic", mode: "anonymous" });
      return ctx.reply(SELECT_OPTION_TEXT, {
        reply_markup: topicKeyboard,
      });
    }
    if (text === MENU_ABOUT) {
      userStates.delete(ctx.from.id);
      return ctx.reply(
        "این پیام‌رسان جهت ارتباط مستقیم با مدیران مجموعه تهیه گردیده است. پیشاپیش از حسن استفاده شما قدردانی می‌نماییم. ℹ️",
        { reply_markup: mainKeyboard }
      );
    }
    if (text === MENU_WEBSITE) {
      userStates.delete(ctx.from.id);
      const ik = new InlineKeyboard().url("ورود به سایت", "https://www.bavarmandan.com/");
      return ctx.reply("برای بازدید از سایت ما کلیک کنید: 🔗", { reply_markup: ik });
    }
  }

  /* ────── If no state was chosen yet, nudge user to pick a menu item ────── */
  if (!state) {
    return ctx.reply("لطفاً ابتدا یکی از گزینه‌ها را از منوی زیر انتخاب کنید. ▫️", {
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
      return ctx.reply(ASK_REPLY_PREFERENCE_TEXT, {
        reply_markup: replyPreferenceKeyboard,
      });
    }

    if (topic === "feedback") {
      const nextState: Extract<UserState, { step: "awaiting_message" }> = {
        step: "awaiting_message",
        mode: state.mode,
        topic: "feedback",
      };
      userStates.set(ctx.from.id, nextState);

      await pinnedModeration.save();
      return ctx.reply(buildFinalPrompt(), {
        reply_markup: mainKeyboard,
      });
    }

    return ctx.reply(SELECT_OPTION_TEXT, {
      reply_markup: topicKeyboard,
    });
  }

  // 2) Expecting how the user wants to receive a reply for a question.
  if (state.step === "awaiting_reply_preference") {
    const replyPreference = parseReplyPreference(text);

    if (!replyPreference) {
      return ctx.reply(SELECT_OPTION_TEXT, {
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

    await pinnedModeration.save();
    return ctx.reply(buildFinalPrompt(), {
      reply_markup: mainKeyboard,
    });
  }

  // 3) Expecting the final message text.
  if (state.step === "awaiting_message") {
    try {
      const groupText = buildGroupMessage(state, ctx.message.text, ctx.from);
      await pinnedModeration.save();
      const sent = await ctx.api.sendMessage(
        TARGET_CHANNEL,
        groupText
      );
      messageMap.set(sent.message_id, ctx.from.id);
      await ctx.reply(MESSAGE_SENT_TEXT, { reply_markup: mainKeyboard });
      userStates.delete(ctx.from.id);
    } catch {
      await ctx.reply(MESSAGE_SEND_ERROR_TEXT, { reply_markup: mainKeyboard });
      // keep state so they can retry
    }
    return;
  }

  // 4) If state is awaiting_file but user typed text, remind them
  if (state.step === "awaiting_file") {
    return ctx.reply("تنها فایل PDF مجاز است. لطفاً فایل خود را ارسال کنید. 📄", {
      reply_markup: mainKeyboard,
    });
  }
});

// Receiving files/photos/etc. in private chat
privateChat.on("message", async (ctx, next) => {
  const state = userStates.get(ctx.from.id);

  // If no state set yet, only nudge once for any non-menu input
  if (!state && ctx.chat.type === "private") {
    await ctx.reply("برای شروع، یکی از گزینه‌ها را از منو انتخاب کنید. ▫️", {
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
        moderation.setDisplay(ctx.from.id, true, ctx.from.username);
        await pinnedModeration.save();
        const sent = await ctx.api.forwardMessage(
          TARGET_CHANNEL,
          ctx.chat.id,
          ctx.message.message_id
        );
        messageMap.set(sent.message_id, ctx.from.id);
        const header = await ctx.api.sendMessage(
          TARGET_CHANNEL,
          `فایل PDF 📄\nشناسه کاربر: ${moderation.labelFor(ctx.from.id)}`,
          { reply_to_message_id: sent.message_id }
        );
        messageMap.set(header.message_id, ctx.from.id);
        await ctx.reply("فایل شما ارسال شد. متشکرم. ✅", { reply_markup: mainKeyboard });
        userStates.delete(ctx.from.id); // clear after success
      } catch {
        await ctx.reply("خطا در ارسال فایل. دوباره تلاش کنید. ⚠️", { reply_markup: mainKeyboard });
        // keep state to retry
      }
      return;
    }

    // Not a PDF → ask again, keep state
    await ctx.reply("تنها فایل PDF مجاز است. لطفاً مجدداً امتحان کنید. 📄", {
      reply_markup: mainKeyboard,
    });
    return;
  }

  if (state.step === "awaiting_topic") {
    await ctx.reply(SELECT_OPTION_TEXT, {
      reply_markup: topicKeyboard,
    });
    return;
  }

  if (state.step === "awaiting_reply_preference") {
    await ctx.reply(SELECT_OPTION_TEXT, {
      reply_markup: replyPreferenceKeyboard,
    });
    return;
  }

  if (state.step === "awaiting_message") {
    await ctx.reply("لطفاً پیام خود را به صورت متن ارسال کنید. 📝", {
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

