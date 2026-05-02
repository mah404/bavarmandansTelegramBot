export async function POST(req: Request) {
  try {
    const body = await req.json();

    console.log("TELEGRAM UPDATE:", JSON.stringify(body));

    const chatId = body.message?.chat?.id;
    const text = body.message?.text;

    if (chatId) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text:
            text === "/start"
              ? "سلام، پیام شما دریافت شد. لطفاً پیام خود را ارسال کنید."
              : "پیام شما دریافت شد. با تشکر.",
        }),
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("BOT ERROR:", error);
    return Response.json({ ok: true });
  }
}

export async function GET() {
  return Response.json({ ok: true, message: "Bot route is alive" });
}