// ============================================================================
//  reputation: review monitoring from the client's Google Business Profile.
// ----------------------------------------------------------------------------
//  Reads the listing through the Google Places API (New): rating, review
//  count and the latest reviews Google returns (up to five). Each check is a
//  reputation_snapshots row; each review ever seen is a reputation_reviews
//  row, so new reviews and low ratings can be flagged. Runs daily (pg_cron
//  seop-daily-reputation) and on demand from the console.
//
//  The listing is found by text search on the client's name + market and
//  pinned (clients.gbp_place_id) when its website is the client's domain;
//  otherwise staff pick it from the search results on the Reputation panel.
//
//  Local Insight (other review sites) plugs in here as a second source once
//  its API is wired; its key already has a slot in Team & access → API keys.
//
//  Actions (POST { action, ... }):
//    overview                         any staff   every active client, latest numbers + alerts
//    get        { client_id }         any staff   latest snapshot, 30-day change, recent reviews
//    search     { client_id, query? } SA / AM     candidate listings to pin
//    set_place  { client_id, place_id|null }  SA / AM  pin (or unpin) the listing, then check it
//    collect    { client_id }         any staff   check now
//    collect_all                      SA/service  daily run over every active client (background)
//  Key: GOOGLE_PLACES_API_KEY (Team & access → API keys, or the function secret).
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// ── Platform keys (Team & access → API keys). A key entered in the console is
// kept in Supabase Vault and wins; otherwise the function secret is used.
// Cached for a minute so a rotation reaches running workers quickly.
const _keys = new Map<string, { v: string; at: number }>();
async function platformKey(name: string): Promise<string> {
  const hit = _keys.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v = "";
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data } = await admin.rpc("platform_key", { p_name: name });
    if (typeof data === "string") v = data;
  } catch { /* Vault lookup unavailable: fall back to the function secret */ }
  v = v || Deno.env.get(name) || "";
  _keys.set(name, { v, at: Date.now() });
  return v;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const VERSION = "1.0.0";
const PLACES = "https://places.googleapis.com/v1";
const DETAIL_FIELDS = "id,displayName,formattedAddress,rating,userRatingCount,reviews,googleMapsUri,websiteUri,businessStatus";
const SEARCH_FIELDS = "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri,places.googleMapsUri";

async function gateCaller(req: Request, roles?: string[]): Promise<{ userId: string | null; role: string } | Response> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!tok) return json({ error: "sign in required" }, 401);
  if (svc && tok === svc) return { userId: null, role: "service" };
  // pg_cron sends the Vault copy of the service key (a legacy JWT, which the
  // gateway's verify_jwt has already checked) — trust its role claim.
  try {
    const part = tok.split(".")[1] || "";
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    if (claims?.role === "service_role") return { userId: null, role: "service" };
  } catch { /* not a JWT */ }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, svc, { auth: { persistSession: false } });
  const { data } = await admin.auth.getUser(tok);
  if (!data?.user) return json({ error: "sign in required" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (!prof) return json({ error: "staff only — this account has no staff profile" }, 403);
  if (roles && !roles.includes(String(prof.role))) return json({ error: "your role can't do this" }, 403);
  return { userId: data.user.id, role: String(prof.role) };
}

const rootOf = (u: string) => String(u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(llc|inc|co|company|the)\b/g, " ").replace(/\s+/g, " ").trim();

async function places(path: string, mask: string, body?: unknown) {
  const key = await platformKey("GOOGLE_PLACES_API_KEY");
  if (!key) throw new Error("no Google Places key — add it in Team & access → API keys");
  const r = await fetch(`${PLACES}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt); } catch { /* non-JSON */ }
  if (!r.ok) {
    const msg = String(j?.error?.message || txt).slice(0, 200);
    throw new Error(`Google Places ${r.status}: ${msg}${r.status === 403 ? " (enable Places API (New) for this key)" : ""}`);
  }
  return j;
}

async function searchListings(query: string) {
  const res = await places("places:searchText", SEARCH_FIELDS, { textQuery: query, pageSize: 8 });
  return (res?.places || []).map((p: any) => ({
    place_id: p.id, name: p.displayName?.text || "", address: p.formattedAddress || "",
    rating: p.rating ?? null, review_count: p.userRatingCount ?? null, website: p.websiteUri || null, maps_url: p.googleMapsUri || null,
  }));
}

async function collectClient(supa: any, clientId: string) {
  const { data: c } = await supa.from("clients").select("id, name, url, market, gbp_place_id").eq("id", clientId).maybeSingle();
  if (!c) throw new Error("client not found");
  const root = rootOf(c.url);
  const row: any = { client_id: clientId, source: "google" };
  try {
    let placeId = String(c.gbp_place_id || "");
    if (!placeId) {
      const cands = await searchListings(`${c.name || root} ${c.market || ""}`.trim());
      const bySite = cands.find((p: any) => root && rootOf(p.website || "") === root);
      const byName = cands.find((p: any) => norm(p.name) && (norm(p.name) === norm(c.name) || norm(p.name).includes(norm(c.name)) || norm(c.name).includes(norm(p.name))));
      const pick = bySite || byName;
      if (!pick) throw new Error("no Google listing matched this client — pin it on the Reputation panel");
      placeId = pick.place_id;
      if (bySite) await supa.from("clients").update({ gbp_place_id: placeId }).eq("id", clientId);
    }
    const p = await places(`places/${encodeURIComponent(placeId)}?languageCode=en`, DETAIL_FIELDS);
    const reviews = (p.reviews || []).map((r: any) => ({
      review_id: String(r.name || ""), rating: r.rating ?? null,
      author: r.authorAttribution?.displayName || null, text: r.text?.text || r.originalText?.text || "",
      published_at: r.publishTime || null, relative: r.relativePublishTimeDescription || null,
      review_url: r.googleMapsUri || null,
    })).filter((r: any) => r.review_id);
    Object.assign(row, { place_id: p.id || placeId, listing_name: p.displayName?.text || null, listing_url: p.googleMapsUri || null,
      rating: p.rating ?? null, review_count: p.userRatingCount ?? 0, reviews });
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") row.error = `Listing status on Google: ${p.businessStatus}`;
    if (reviews.length) {
      await supa.from("reputation_reviews").upsert(reviews.map((r: any) => ({
        client_id: clientId, source: "google", review_id: r.review_id, rating: r.rating, author: r.author,
        text: r.text, published_at: r.published_at, review_url: r.review_url,
      })), { onConflict: "client_id,source,review_id", ignoreDuplicates: true });
    }
  } catch (e) {
    row.error = String((e as any)?.message || e).slice(0, 400);
  }
  const { data, error } = await supa.from("reputation_snapshots").insert(row).select("id, captured_at").single();
  if (error) throw new Error(`saving snapshot: ${error.message}`);
  return { ...row, id: data.id, captured_at: data.captured_at };
}

// Latest usable snapshot + the one closest to 30 days earlier, for the change.
async function summaryFor(supa: any, clientIds: string[]) {
  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const { data: snaps } = await supa.from("reputation_snapshots")
    .select("client_id, captured_at, rating, review_count, listing_name, listing_url, error")
    .in("client_id", clientIds).eq("source", "google").gte("captured_at", since).order("captured_at", { ascending: false }).limit(5000);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  // "New" = published on Google in the last 7 days (the first check sees a
  // listing's existing reviews for the first time; they aren't new).
  const { data: fresh } = await supa.from("reputation_reviews").select("client_id, rating, published_at")
    .in("client_id", clientIds).gte("published_at", week).limit(5000);
  const out: Record<string, any> = {};
  for (const id of clientIds) {
    const mine = (snaps || []).filter((s: any) => s.client_id === id);
    const good = mine.filter((s: any) => s.rating != null || s.review_count != null);
    const latest = good[0] || null;
    const target = Date.now() - 30 * 86400000;
    const base = good.length ? good.reduce((b: any, s: any) => Math.abs(new Date(s.captured_at).getTime() - target) < Math.abs(new Date(b.captured_at).getTime() - target) ? s : b) : null;
    const newOnes = (fresh || []).filter((r: any) => r.client_id === id);
    out[id] = {
      latest, last_error: mine[0]?.error || null, last_checked: mine[0]?.captured_at || null,
      rating_change_30d: latest && base && base !== latest && latest.rating != null && base.rating != null ? Math.round((latest.rating - base.rating) * 10) / 10 : null,
      reviews_change_30d: latest && base && base !== latest ? (latest.review_count ?? 0) - (base.review_count ?? 0) : null,
      new_reviews_7d: newOnes.length, low_reviews_7d: newOnes.filter((r: any) => (r.rating ?? 5) <= 2).length,
    };
  }
  return out;
}

async function eachClient(ids: string[], fn: (id: string) => Promise<unknown>, conc = 4) {
  const stats = { ok: 0, failed: 0, errors: [] as string[] };
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { const r: any = await fn(id); if (r?.error) stats.errors.push(`${id}: ${r.error}`); stats.ok++; }
      catch (e) { stats.failed++; stats.errors.push(`${id}: ${String((e as any)?.message || e).slice(0, 160)}`); }
    }
  }));
  return stats;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const roles: Record<string, string[] | undefined> = {
    overview: undefined, get: undefined, collect: undefined,
    search: ["super_admin", "account_manager"], set_place: ["super_admin", "account_manager"],
    collect_all: ["super_admin"],
  };
  if (!(action in roles)) return json({ error: `unknown action "${action}"` }, 400);
  const who = await gateCaller(req, roles[action]);
  if (who instanceof Response) return who;
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    if (action === "overview") {
      const { data: cl } = await supa.from("clients").select("id, name, url, partner_group_id, gbp_place_id").eq("status", "active").order("name");
      const ids = (cl || []).map((c: any) => c.id);
      const sum = ids.length ? await summaryFor(supa, ids) : {};
      const keySet = !!(await platformKey("GOOGLE_PLACES_API_KEY"));
      return json({ ok: true, version: VERSION, google_key_set: keySet, local_insight_key_set: !!(await platformKey("LOCAL_INSIGHT_API_KEY")),
        clients: (cl || []).map((c: any) => ({ id: c.id, name: c.name, url: c.url, group_id: c.partner_group_id, pinned: !!c.gbp_place_id, ...sum[c.id] })) });
    }
    if (action === "collect_all") {
      const { data: cl } = await supa.from("clients").select("id").eq("status", "active");
      const ids = (cl || []).map((c: any) => c.id);
      if (!(await platformKey("GOOGLE_PLACES_API_KEY"))) return json({ ok: true, skipped: "no Google Places key yet", clients: ids.length });
      const work = eachClient(ids, (id) => collectClient(supa, id))
        .then((r) => console.log("reputation collect_all", JSON.stringify(r).slice(0, 2000)))
        .catch((e) => console.error("reputation collect_all", e));
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(work); else await work;
      return json({ ok: true, background: true, clients: ids.length }, 202);
    }

    const clientId = String(body.client_id || "");
    if (!clientId) return json({ error: "client_id required" }, 400);

    if (action === "get") {
      const { data: c } = await supa.from("clients").select("id, name, url, market, gbp_place_id").eq("id", clientId).maybeSingle();
      if (!c) return json({ error: "client not found" }, 404);
      const sum = (await summaryFor(supa, [clientId]))[clientId];
      const { data: recent } = await supa.from("reputation_reviews").select("rating, author, text, published_at, review_url, first_seen_at")
        .eq("client_id", clientId).order("published_at", { ascending: false, nullsFirst: false }).limit(10);
      const { data: hist } = await supa.from("reputation_snapshots").select("captured_at, rating, review_count")
        .eq("client_id", clientId).eq("source", "google").not("rating", "is", null).order("captured_at", { ascending: false }).limit(90);
      return json({ ok: true, client: { name: c.name, market: c.market, place_id: c.gbp_place_id }, google_key_set: !!(await platformKey("GOOGLE_PLACES_API_KEY")),
        summary: sum, recent_reviews: recent || [], history: (hist || []).reverse() });
    }
    if (action === "search") {
      const { data: c } = await supa.from("clients").select("name, url, market").eq("id", clientId).maybeSingle();
      if (!c) return json({ error: "client not found" }, 404);
      const q = String(body.query || "").trim() || `${c.name || rootOf(c.url)} ${c.market || ""}`.trim();
      const root = rootOf(c.url);
      const cands = (await searchListings(q)).map((p: any) => ({ ...p, website_matches: !!root && rootOf(p.website || "") === root }));
      return json({ ok: true, query: q, candidates: cands });
    }
    if (action === "set_place") {
      const pid = body.place_id ? String(body.place_id).trim() : null;
      if (pid && !/^[A-Za-z0-9_-]{10,300}$/.test(pid)) return json({ error: "that doesn't look like a Google place id" }, 400);
      const { error } = await supa.from("clients").update({ gbp_place_id: pid }).eq("id", clientId);
      if (error) return json({ error: error.message }, 500);
      const snap = pid ? await collectClient(supa, clientId) : null;
      return json({ ok: true, snapshot: snap });
    }
    if (action === "collect") return json({ ok: true, snapshot: await collectClient(supa, clientId) });
    return json({ error: "unhandled action" }, 400);
  } catch (e) {
    console.error("reputation", action, e);
    return json({ error: String((e as any)?.message || e).slice(0, 400) }, 500);
  }
});
