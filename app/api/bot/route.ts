export async function POST(req: Request) {
  const body = await req.json();

  console.log("TELEGRAM UPDATE:", JSON.stringify(body));

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, message: "Bot route is alive" });
}