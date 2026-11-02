// Supabase Edge Function "claude": lets signed-in E-Notes users ask Claude about a sheet.
// The Anthropic API key stays here on the server (secret ANTHROPIC_API_KEY), never in the app.
//
// Secrets (npx supabase secrets set NAME=value):
//   ANTHROPIC_API_KEY  required
//   ALLOWED_EMAILS     optional, comma separated; when set, only these accounts may use Claude
//   AI_DAILY_LIMIT     optional, requests per user per day (default 50)
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "50");
const ALLOWED = (Deno.env.get("ALLOWED_EMAILS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_IMAGE_B64 = 7_000_000; // ~5 MB JPEG

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM =
  "You are the study assistant inside E-Notes, a handwriting notebook app. " +
  "The user shares a picture of one notebook sheet: usually a PDF page on one side and their handwritten notes " +
  "in the margin, or a blank page with handwriting. Reply in the language the user writes in " +
  "(Bengali, English or Banglish). Keep answers concise and in plain text without Markdown headings, " +
  "tables or bold markers, because the answer may be placed on the sheet as a text box. " +
  "Simple '-' bullet lines are fine.";

const PROMPTS: Record<string, string> = {
  transcribe:
    "Transcribe all of my handwritten notes on this sheet into plain text. Keep my wording, order and line breaks. " +
    "Do not copy the printed PDF text. If a word is unclear, give your best guess followed by (?). " +
    "Reply with only the transcription.",
  summarize: "Summarize this sheet (the page and my notes) in 5 to 8 short '-' bullet points.",
  explain:
    "Explain the main ideas on this page simply, like a good teacher. " +
    "If my handwritten notes contain a mistake or misunderstanding, point it out kindly.",
  quiz: "Write 5 short quiz questions to test me on this sheet. Put the answers after all the questions.",
};

type Turn = { role: "user" | "assistant"; content: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // 1. Who is asking? (the app sends the user's Supabase session token)
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  if (!user) return json({ error: "Please sign in to use Claude." }, 401);
  if (ALLOWED.length && !ALLOWED.includes((user.email ?? "").toLowerCase())) {
    return json({ error: `Claude is not enabled for ${user.email}. Ask the app owner to add your email.` }, 403);
  }

  // 2. What do they want?
  let body: { action?: string; question?: string; image?: string; history?: Turn[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const prompt = body.action === "ask" ? String(body.question ?? "").trim().slice(0, 4000) : PROMPTS[body.action ?? ""];
  if (!prompt) return json({ error: "Write a question first." }, 400);
  if (typeof body.image !== "string" || !body.image || body.image.length > MAX_IMAGE_B64) {
    return json({ error: "The sheet picture is missing or too large." }, 400);
  }

  // 3. Daily limit
  const { data: used, error: usageError } = await supabase.rpc("bump_ai_usage");
  if (usageError) return json({ error: "Usage tracking failed. Run the latest supabase/schema.sql." }, 500);
  if (used > DAILY_LIMIT) {
    return json({ error: `Today's Claude limit (${DAILY_LIMIT} requests) is used up. Try again tomorrow.` }, 429);
  }

  // 4. Build the conversation: the sheet picture goes with the first user turn.
  const past: Turn[] = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  while (past.length && past[0].role !== "user") past.shift();
  const turns: Turn[] = [...past, { role: "user", content: prompt }];
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((m, i) =>
    i === 0
      ? {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: body.image! } },
            { type: "text", text: m.content },
          ],
        }
      : m
  );

  // 5. Ask Claude
  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium" },
      // If a safety check declines the request, the API retries on a suitable fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });
    if (response.stop_reason === "refusal") {
      return json({ error: "Claude declined to answer this request." }, 422);
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return json({ text, used, limit: DAILY_LIMIT, truncated: response.stop_reason === "max_tokens" });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Claude is busy. Try again in a minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) {
      return json({ error: "The server's ANTHROPIC_API_KEY is missing or invalid." }, 500);
    }
    if (err instanceof Anthropic.APIError) return json({ error: `Claude API error (${err.status}).` }, 502);
    return json({ error: "Could not reach Claude." }, 502);
  }
});
