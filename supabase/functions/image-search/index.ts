// ============================================================================
//  image-search — Pexels stock-photo search for GBP posts & blog images.
// ----------------------------------------------------------------------------
//  The console's image picker calls this; the Pexels key never reaches the
//  browser. Free Pexels API: https://www.pexels.com/api/ (attribution
//  appreciated, not required; photos are free to use).
//
//  Deploy: Edge Functions → image-search.  Secret: PEXELS_API_KEY.
//  Input:  { query: "roof repair", per_page?: 12 }
//  Output: { ok, photos: [{ id, url, thumb, alt, photographer, page }] }
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ── Caller gate (QA 2026-10-28). verify_jwt alone is not access control here:
// the public anon key shipped in the console is itself a valid JWT, and email
// sign-up is open. Every request must come from the service role (scheduler,
// function-to-function) or a staff member (a row in profiles), optionally
// holding one of `roles`.
async function gateCaller(req: Request, roles?: string[]): Promise<{ userId: string | null; role: string } | Response> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!tok) return json({ error: "sign in required" }, 401);
  if (svc && tok === svc) return { userId: null, role: "service" };
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, svc, { auth: { persistSession: false } });
  const { data } = await admin.auth.getUser(tok);
  if (!data?.user) return json({ error: "sign in required" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (!prof) return json({ error: "staff only — this account has no staff profile" }, 403);
  if (roles && !roles.includes(String(prof.role))) return json({ error: "your role can't do this" }, 403);
  return { userId: data.user.id, role: String(prof.role) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    // staff only (a signed-in stranger must not spend the Pexels quota)
    const who = await gateCaller(req);
    if (who instanceof Response) return who;
    const KEY = Deno.env.get("PEXELS_API_KEY");
    if (!KEY) return json({ error: "PEXELS_API_KEY is not set — add it under Edge Functions → image-search → Secrets (free key from pexels.com/api)" }, 500);

    const body = await req.json().catch(() => ({}));
    const query = String(body.query || "").trim();
    if (!query) return json({ error: "query required" }, 400);
    const perPage = Math.min(Math.max(1, Number(body.per_page) || 12), 24);

    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`, {
      headers: { Authorization: KEY },
    });
    if (!r.ok) return json({ error: `Pexels HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
    const data = await r.json();
    return json({ ok: true, photos: (data.photos || []).map((p: any) => ({
      id: p.id,
      url: p.src?.large || p.src?.original,        // ~940px — right size for featured images
      thumb: p.src?.medium || p.src?.small,
      alt: p.alt || query,
      photographer: p.photographer || "",
      page: p.url || "",
    })) });
  } catch (e) {
    console.error("image-search fatal", e);
    return json({ error: String((e as any)?.message || e).slice(0, 400) }, 500);
  }
});
