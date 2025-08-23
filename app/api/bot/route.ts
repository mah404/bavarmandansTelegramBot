export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import { Bot, webhookCallback, Keyboard } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token)
  throw new Error("TELEGRAM_BOT_TOKEN environment variable not found.");

const bot = new Bot(token);

// const TARGET_CHANNEL = "-1002874971287";
const TARGET_CHANNEL = "-1002825832693";

const userStates = new Map<
  number,
  "awaiting_file" | "awaiting_text" | "awaiting_anonymous_text"
>();

const messageMap = new Map<number, number>(); // groupMessageId -> userId

/* ─────────────────────  کیبورد اصلی  ───────────────────── */
const mainKeyboard = new Keyboard()
  .text("📄 ارسال فایل پی‌دی‌اف")
  .text("💬 ارسال پیام")
  .row()
  .text("🔒 ارسال پیام به صورت ناشناس")
  .row()
  .text("ℹ️ درباره ما")
  .text("🌐 لینک سایت")
  // UX helpers: persistent keyboard + input placeholder
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

bot.command("start", async (ctx) => {
  await ctx.reply(
    `با عرض سلام مجدد،

جهت برقراری ارتباط یکی از گزینه‌های موجود را انتخاب نمایید. 

با تشکر`,
    { reply_markup: mainKeyboard }
  );
});

/* ─────────────────────  منوی اصلی و منطق حالت‌ها  ───────────────────── */
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  // پاسخ ادمین در گروه ادمین‌ها (روی یک پیام ریپلای شده)
  const isGroup = ctx.chat.id.toString() === TARGET_CHANNEL;
  const replied = ctx.message.reply_to_message;

  if (isGroup && replied) {
    const uid = messageMap.get(replied.message_id);
    if (uid) {
      try {
        await ctx.api.sendMessage(uid, `پاسخ ادمین:\n${ctx.message.text}`);
        await ctx.reply("پاسخ برای کاربر ارسال شد ✅", {
          reply_to_message_id: ctx.message.message_id,
        });
      } catch {
        await ctx.reply("❌ خطا در ارسال پاسخ به کاربر.");
      }
    }
    return;
  }

  /* ────── تنها کلیدها قبل از انتخاب حالت مجازند ────── */
  const state = userStates.get(ctx.from.id);

  // اگر هنوز هیچ گزینه‌ای انتخاب نشده و متن ارسالی جزو منو نیست، فقط تذکر بده و هیچ کاری نکن
  if (!state && !MENU_TEXTS.has(text)) {
    return ctx.reply(
      "🚨 لطفاً ابتدا یکی از گزینه‌ها را از منوی زیر انتخاب کنید.",
      {
        reply_markup: mainKeyboard,
      }
    );
  }

  /* ────── گزینه‌های کاربر (تنها مسیر ورود به حالت‌ها) ────── */
  if (text === "📄 ارسال فایل پی‌دی‌اف") {
    userStates.set(ctx.from.id, "awaiting_file");
    return ctx.reply("لطفاً فایل PDF خود را ارسال کنید.", {
      reply_markup: mainKeyboard,
    });
  }
  if (text === "💬 ارسال پیام") {
    userStates.set(ctx.from.id, "awaiting_text");
    return ctx.reply("پیام خود را وارد نمایید.", {
      reply_markup: mainKeyboard,
    });
  }
  if (text === "🔒 ارسال پیام به صورت ناشناس") {
    userStates.set(ctx.from.id, "awaiting_anonymous_text");
    return ctx.reply("پیام ناشناس خود را وارد نمایید.", {
      reply_markup: mainKeyboard,
    });
  }
  if (text === "ℹ️ درباره ما") {
    return ctx.reply(
      "این پیام‌رسان جهت ارتباط مستقیم با مدیران مجموعه تهیه گردیده است. پیشاپیش از حسن استفاده شما قدردانی می‌نماییم.",
      { reply_markup: mainKeyboard }
    );
  }
  if (text === "🌐 لینک سایت") {
    return ctx.reply("برای بازدید از سایت ما کلیک کنید:", {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "ورود به سایت",
              url: "https://bavarmandanclubhouse.vercel.app/",
            },
          ],
        ],
      },
    });
  }

  /* ────── پردازش بر اساس وضعیت ────── */

  // 1) دریافت فایل PDF
  if (state === "awaiting_file") {
    if (
      ctx.message.document &&
      ctx.message.document.mime_type === "application/pdf"
    ) {
      try {
        const sent = await ctx.api.forwardMessage(
          TARGET_CHANNEL,
          ctx.chat.id,
          ctx.message.message_id
        );
        messageMap.set(sent.message_id, ctx.from.id);
        await ctx.reply("فایل شما ارسال شد. متشکرم!", {
          reply_markup: mainKeyboard,
        });
        userStates.delete(ctx.from.id); // فقط پس از موفقیت پاک کن
      } catch {
        await ctx.reply("❌ خطا در ارسال فایل. دوباره تلاش کنید.", {
          reply_markup: mainKeyboard,
        });
        // حالت را نگه دار تا کاربر دوباره فایل صحیح بفرستد
      }
    } else {
      await ctx.reply("تنها فایل PDF مجاز است. لطفاً مجدداً امتحان کنید.", {
        reply_markup: mainKeyboard,
      });
      // حالت را نگه می‌داریم
    }
    return;
  }

  // 2) دریافت پیام معمولی (با هویت کاربر)
  if (state === "awaiting_text") {
    if (ctx.message.text) {
      try {
        const sent = await ctx.api.sendMessage(
          TARGET_CHANNEL,
          `پیام از ${ctx.from.first_name} (@${
            ctx.from.username || "بدون‌نام کاربری"
          }):\n${ctx.message.text}`
        );
        messageMap.set(sent.message_id, ctx.from.id);
        await ctx.reply("پیام شما ارسال گردید.", {
          reply_markup: mainKeyboard,
        });
        userStates.delete(ctx.from.id);
      } catch {
        await ctx.reply("❌ خطا در ارسال پیام. دوباره تلاش کنید.", {
          reply_markup: mainKeyboard,
        });
      }
    } else {
      await ctx.reply("لطفاً فقط پیام متنی ارسال کنید.", {
        reply_markup: mainKeyboard,
      });
      // حالت را نگه می‌داریم
    }
    return;
  }

  // 3) دریافت پیام ناشناس
  if (state === "awaiting_anonymous_text") {
    if (ctx.message.text) {
      try {
        const sent = await ctx.api.sendMessage(
          TARGET_CHANNEL,
          `پیام ناشناس:\n${ctx.message.text}`
        );
        messageMap.set(sent.message_id, ctx.from.id);
        await ctx.reply("پیام ناشناس شما ارسال گردید.", {
          reply_markup: mainKeyboard,
        });
        userStates.delete(ctx.from.id);
      } catch {
        await ctx.reply("❌ خطا در ارسال پیام ناشناس. دوباره تلاش کنید.", {
          reply_markup: mainKeyboard,
        });
      }
    } else {
      await ctx.reply("لطفاً فقط پیام متنی ارسال کنید.", {
        reply_markup: mainKeyboard,
      });
      // حالت را نگه می‌داریم
    }
    return;
  }
});

// (اختیاری) اگر فایل/عکس/ویدئو بفرستند زمانی که حالت انتخاب نشده، تذکر بده
bot.on("message", async (ctx, next) => {
  const state = userStates.get(ctx.from.id);
  if (!state) {
    // پیام‌های غیرمتنی یا متنی که به منو نمی‌خورد، اینجا هم می‌آیند
    await ctx.reply("برای شروع، یکی از گزینه‌ها را از منو انتخاب کنید.", {
      reply_markup: mainKeyboard,
    });
    return;
  }
  return next();
});

import { type NextRequest } from "next/server";
export async function POST(req: NextRequest) {
  return await webhookCallback(bot, "std/http")(req);
}
