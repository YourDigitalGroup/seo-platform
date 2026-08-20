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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const KEY = Deno.env.get("PEXELS_API_KEY");
    if (!KEY) return json({ error: "PEXELS_API_KEY is not set — add it under Edge Functions → image-search → Secrets (free key from pexels.com/api)" }, 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // signed-in staff only
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await supa.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "sign in required" }, 401);

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
