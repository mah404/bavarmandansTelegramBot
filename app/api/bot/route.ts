export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import { Bot, webhookCallback, Keyboard } from "grammy";
import { type NextRequest } from "next/server";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable not found.");

const bot = new Bot(token);

// آی‌دی گروه یا سوپرگروهی که فقط ادمین‌ها حضور دارند
const TARGET_CHANNEL = "-4815354265"; // ← make sure this is correct

// وضعیت کاربر در جریان گفت‌وگو
const userStates = new Map<number, "awaiting_file" | "awaiting_text" | "awaiting_anonymous_text">();

// نگه‌داشتن لینک بین پیام ارسالی در گروه و آی‌دی کاربر برای پاسخ ادمین
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
  .resized();

bot.command("start", async (ctx) => {
  await ctx.reply(
    `با عرض سلام مجدد،

جهت برقراری ارتباط یکی از گزینه‌های موجود را انتخاب نمایید. 

با تشکر`,
    {
      reply_markup: mainKeyboard,
    }
  );
});

/* ─────────────────────  منوی اصلی  ───────────────────── */
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const isGroup = ctx.chat.id.toString() === TARGET_CHANNEL;
  const replied = ctx.message.reply_to_message;

  // پاسخ ادمین به پیام کاربر
  if (isGroup && replied) {
    const uid = messageMap.get(replied.message_id);
    if (uid) {
      try {
        await ctx.api.sendMessage(uid, `پاسخ ادمین:\n${ctx.message.text}`);
        await ctx.reply("پاسخ برای کاربر ارسال شد ✅", {
          reply_to_message_id: ctx.message.message_id,
        });
      } catch (err) {
        console.error("❌ Error sending admin reply:", err);
        await ctx.reply("❌ خطا در ارسال پاسخ به کاربر.");
      }
    }
    return;
  }

  /* ────── گزینه‌های کاربر ────── */
  if (text === "📄 ارسال فایل پی‌دی‌اف") {
    userStates.set(ctx.from.id, "awaiting_file");
    return ctx.reply("لطفاً فایل PDF خود را ارسال کنید.");
  }

  if (text === "💬 ارسال پیام") {
    userStates.set(ctx.from.id, "awaiting_text");
    return ctx.reply(" پیام خود را وارد نمایید.");
  }

  if (text === "🔒 ارسال پیام به صورت ناشناس") {
    userStates.set(ctx.from.id, "awaiting_anonymous_text");
    return ctx.reply("پیام خود به صورت ناشناس را وارد نمایید");
  }

  if (text === "ℹ️ درباره ما") {
    return ctx.reply(
      "این پیام رسان جهت ارتباط مستقیم با مدیران مجموعه تهیه گردیده است. پیشاپیش از حسن استفاده شما قدردانی می‌نماییم."
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
  const state = userStates.get(ctx.from.id);

  // دریافت فایل PDF
  if (state === "awaiting_file") {
    if (ctx.message.document && ctx.message.document.mime_type === "application/pdf") {
      try {
        const sent = await ctx.api.forwardMessage(
          TARGET_CHANNEL,
          ctx.chat.id,
          ctx.message.message_id
        );
        messageMap.set(sent.message_id, ctx.from.id);
        await ctx.reply("فایل شما ارسال شد. متشکرم!");
      } catch (err) {
        console.error("❌ Error sending PDF:", err);
        await ctx.reply("❌ خطا در ارسال فایل. دوباره تلاش کنید.");
      }
    } else {
      await ctx.reply("فقط فایل PDF مجاز است. لطفاً مجدداً امتحان کنید.");
    }
    return userStates.delete(ctx.from.id);
  }

  // دریافت پیام معمولی
  if (state === "awaiting_text") {
    if (ctx.message.text) {
      try {
        const sent = await ctx.api.sendMessage(
          TARGET_CHANNEL,
          `پیام از ${ctx.from.first_name} (@${ctx.from.username || "بدون‌نام کاربری"}):\n${ctx.message.text}`
        );
        messageMap.set(sent.message_id, ctx.from.id);
        await ctx.reply("پیام شما ارسال گردید");
      } catch (err) {
        console.error("❌ Error sending regular message:", err);
        await ctx.reply("❌ خطا در ارسال پیام. دوباره تلاش کنید.");
      }
    } else {
      await ctx.reply("لطفاً فقط پیام متنی ارسال کنید.");
    }
    return userStates.delete(ctx.from.id);
  }

  // دریافت پیام ناشناس
  if (state === "awaiting_anonymous_text") {
    if (ctx.message.text) {
      try {
        const sent = await ctx.api.sendMessage(
          TARGET_CHANNEL,
          `پیام ناشناس:\n${ctx.message.text}`
        );
        messageMap.set(sent.message_id, ctx.from.id);
        await ctx.reply("پیام ناشناس شما ارسال گردید");
      } catch (err) {
        console.error("❌ Error sending anonymous message:", err);
        await ctx.reply("❌ خطا در ارسال پیام ناشناس. دوباره تلاش کنید.");
      }
    } else {
      await ctx.reply("لطفاً فقط پیام متنی ارسال کنید.");
    }
    return userStates.delete(ctx.from.id);
  }
});

/* ─────────────────────  Webhook Handler  ───────────────────── */
export async function POST(req: NextRequest) {
  return await webhookCallback(bot, "std/http")(req);
}
