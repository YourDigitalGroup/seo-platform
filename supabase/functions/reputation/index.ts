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
//  Local Incite (our review-management vendor, a white label of Online
//  Review Manager) is the second source: every review site it watches
//  (Google, Facebook, Yelp and more), lifetime rating and count, and response
//  backlog. Each client is linked to its Local Incite location
//  (clients.local_incite_location_id): automatically when the names match
//  exactly, otherwise picked on the Reputation panel.
//
//  Actions (POST { action, ... }):
//    overview                         any staff   every active client, latest numbers + alerts
//    get        { client_id }         any staff   latest snapshot, 30-day change, recent reviews
//    search     { client_id, query? } SA / AM     candidate listings to pin
//    set_place  { client_id, place_id|null }  SA / AM  pin (or unpin) the listing, then check it
//    collect    { client_id }         any staff   check now
//    collect_all                      SA/service  daily run over every active client (background)
//    li_locations { client_id? }      SA / AM     Local Incite locations (+ suggested match)
//    set_li_location { client_id, location_id|null }  SA / AM  link (or unlink), then check
//  Keys: GOOGLE_PLACES_API_KEY, LOCAL_INCITE_API_KEY (Team & access → API keys).
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

const VERSION = "1.1.0";
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

// ── Local Incite (Online Review Manager API v1; the agency key is a query or
// form parameter). getreviews must send mark_review_retrieve=N, or the API
// marks the reviews as retrieved and stops returning them.
const LI = "https://api.online-review-manager.com/v1";
async function li(path: string, params: Record<string, string> = {}, form = false) {
  const key = await platformKey("LOCAL_INCITE_API_KEY");
  if (!key) throw new Error("no Local Incite key — add it in Team & access → API keys");
  let r: Response;
  if (form) {
    const fd = new FormData(); fd.set("api_key", key);
    for (const [k, v] of Object.entries(params)) fd.set(k, v);
    r = await fetch(`${LI}/${path}`, { method: "POST", body: fd, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } else {
    const u = new URL(`${LI}/${path}`); u.searchParams.set("api_key", key);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  }
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt); } catch { /* non-JSON */ }
  if (!r.ok || j?.status === "error") throw new Error(`Local Incite ${r.status}: ${String(j?.message || txt).slice(0, 200)}`);
  return j;
}
async function liLocations() {
  const j = await li("getlocations");
  return (j?.message?.locations || []).map((l: any) => {
    const full = String(l.location_name || ""), city = String(l.city || "");
    return { location_id: String(l.location_id || ""), store_id: String(l.store_id || ""), full_name: full,
      name: city && full.endsWith(` - ${city}`) ? full.slice(0, -(city.length + 3)) : full,
      city, state: String(l.state || ""), url: String(l.location_url || ""), enabled: l.locationStatus !== "disable" };
  }).filter((l: any) => l.location_id);
}
// Lifetime stats for every location (or one), keyed by store_id.
async function liStats(locationId?: string) {
  const j = await li("reports/reviews/stats", locationId ? { location_id: locationId } : {}, true);
  const m = new Map<string, any>();
  for (const st of j?.stores || []) m.set(String(st?.details?.store_id ?? ""), st);
  return m;
}
const siteName = (s: unknown) => {
  const t = String(s || "").toLowerCase();
  return t.includes("google") ? "Google" : t.includes("facebook") ? "Facebook" : t.includes("yelp") ? "Yelp"
    : t.includes("bbb") || t.includes("better business") ? "BBB" : t ? String(s).replace(/^www\./i, "") : "Other";
};
// Exact name (or website) match only; anything looser is offered, not linked.
function liMatch(c: any, locs: any[]) {
  const n = norm(c.name), root = rootOf(c.url);
  const exact = locs.filter((l) => (root && l.url && rootOf(l.url) === root) || (n && norm(l.name) === n));
  if (exact.length === 1) return { loc: exact[0], sure: true };
  const loose = locs.filter((l) => { const m = norm(l.name); return n.length >= 5 && m.length >= 5 && (m.includes(n) || n.includes(m)); });
  return loose.length === 1 ? { loc: loose[0], sure: false } : null;
}
type LiCtx = { locs?: any[]; stats?: Map<string, any> };
async function collectLocalIncite(supa: any, c: any, ctx: LiCtx = {}) {
  const row: any = { client_id: c.id, source: "local_incite", place_id: c.local_incite_location_id };
  try {
    const locs = ctx.locs || await liLocations();
    const loc = locs.find((l: any) => l.location_id === c.local_incite_location_id);
    if (!loc) throw new Error("the linked Local Incite location wasn't found — pick it again on the Reputation panel");
    const st = ctx.stats?.get(loc.store_id) || [...(await liStats(loc.location_id)).values()][0];
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const rv = await li("getreviews", { location_id: loc.location_id, start_date: day(Date.now() - 45 * 86400000), end_date: day(Date.now() + 86400000),
      review_count: "100", sequence: "desc", mark_review_retrieve: "N" });
    const reviews = (rv?.message?.reviews || []).map((r: any) => ({
      review_id: String(r.review_id ?? ""), site: siteName(r.review_site),
      rating: r.rating === "" || r.rating == null ? null : Number(r.rating),
      author: r.reviewer || null, text: r.message || "",
      published_at: r.review_date ? new Date(String(r.review_date).replace(" ", "T") + "Z").toISOString() : null,
      review_url: r.link || r.directory_url || null,
    })).filter((r: any) => r.review_id);
    const ag = st?.aggregate || {}, av = st?.average || {}, rt = st?.rating || {};
    const num = (v: unknown) => v === "" || v == null || isNaN(Number(v)) ? null : Number(v);
    const sites: Record<string, number> = {};
    for (const r of reviews) sites[r.site] = (sites[r.site] || 0) + 1;
    Object.assign(row, { listing_name: loc.full_name, rating: num(av.avg_rating) == null ? null : Math.round(num(av.avg_rating)! * 100) / 100,
      review_count: num(ag.total_reviews), reviews: reviews.slice(0, 10),
      stats: { awaiting_response: num(ag.reviews_no_responses), negative_unanswered: num(ag.negative_reviews_no_responses),
        responses: num(ag.total_responses), avg_response_days: num(av.avg_response_time_in_days), flagged: num(ag.total_flagged_reviews),
        stars: [1, 2, 3, 4, 5].map((n) => num(rt[`total_rating_${n}`]) ?? 0), sites_45d: sites } });
    if (!st) row.error = "Local Incite has no review stats for this location yet";
    if (reviews.length) {
      await supa.from("reputation_reviews").upsert(reviews.map((r: any) => ({
        client_id: c.id, source: "local_incite", review_id: r.review_id, site: r.site, rating: r.rating, author: r.author,
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

// Latest usable snapshot + the one closest to 30 days earlier, for the change,
// per source. New / low reviews come from Local Incite when the client is
// linked (it covers Google too), otherwise from Google.
function sourceSummary(mine: any[]) {
  const good = mine.filter((x: any) => x.rating != null || x.review_count != null);
  const latest = good[0] || null;
  const target = Date.now() - 30 * 86400000;
  const base = good.length ? good.reduce((b: any, x: any) => Math.abs(new Date(x.captured_at).getTime() - target) < Math.abs(new Date(b.captured_at).getTime() - target) ? x : b) : null;
  return {
    latest, last_error: mine[0]?.error || null, last_checked: mine[0]?.captured_at || null,
    rating_change_30d: latest && base && base !== latest && latest.rating != null && base.rating != null ? Math.round((latest.rating - base.rating) * 10) / 10 : null,
    reviews_change_30d: latest && base && base !== latest ? (latest.review_count ?? 0) - (base.review_count ?? 0) : null,
  };
}
async function summaryFor(supa: any, clientIds: string[], liLinked: Set<string> = new Set()) {
  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const { data: snaps } = await supa.from("reputation_snapshots")
    .select("client_id, source, captured_at, rating, review_count, listing_name, listing_url, error, stats")
    .in("client_id", clientIds).gte("captured_at", since).order("captured_at", { ascending: false }).limit(10000);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  // "New" = published in the last 7 days (the first check sees a listing's
  // existing reviews for the first time; they aren't new).
  const { data: fresh } = await supa.from("reputation_reviews").select("client_id, source, rating, published_at")
    .in("client_id", clientIds).gte("published_at", week).limit(10000);
  const out: Record<string, any> = {};
  for (const id of clientIds) {
    const mine = (snaps || []).filter((x: any) => x.client_id === id);
    const src = liLinked.has(id) ? "local_incite" : "google";
    const newOnes = (fresh || []).filter((r: any) => r.client_id === id && r.source === src);
    out[id] = {
      ...sourceSummary(mine.filter((x: any) => x.source === "google")),
      li: liLinked.has(id) ? sourceSummary(mine.filter((x: any) => x.source === "local_incite")) : null,
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
    li_locations: ["super_admin", "account_manager"], set_li_location: ["super_admin", "account_manager"],
  };
  if (!(action in roles)) return json({ error: `unknown action "${action}"` }, 400);
  const who = await gateCaller(req, roles[action]);
  if (who instanceof Response) return who;
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    if (action === "overview") {
      const { data: cl } = await supa.from("clients").select("id, name, url, partner_group_id, gbp_place_id, local_incite_location_id").eq("status", "active").order("name");
      const ids = (cl || []).map((c: any) => c.id);
      const linked = new Set<string>((cl || []).filter((c: any) => c.local_incite_location_id).map((c: any) => c.id));
      const sum = ids.length ? await summaryFor(supa, ids, linked) : {};
      return json({ ok: true, version: VERSION, google_key_set: !!(await platformKey("GOOGLE_PLACES_API_KEY")), local_incite_key_set: !!(await platformKey("LOCAL_INCITE_API_KEY")),
        clients: (cl || []).map((c: any) => ({ id: c.id, name: c.name, url: c.url, group_id: c.partner_group_id, pinned: !!c.gbp_place_id, li_linked: !!c.local_incite_location_id, ...sum[c.id] })) });
    }
    if (action === "collect_all") {
      const { data: cl } = await supa.from("clients").select("id, name, url, local_incite_location_id").eq("status", "active");
      const ids = (cl || []).map((c: any) => c.id);
      const hasGoogle = !!(await platformKey("GOOGLE_PLACES_API_KEY")), hasLi = !!(await platformKey("LOCAL_INCITE_API_KEY"));
      if (!hasGoogle && !hasLi) return json({ ok: true, skipped: "no Google Places or Local Incite key yet", clients: ids.length });
      const work = (async () => {
        // Local Incite: one locations call + one stats call for the whole run,
        // link exact name matches, then one review call per linked client.
        const ctx: LiCtx = {};
        if (hasLi) {
          try { ctx.locs = await liLocations(); ctx.stats = await liStats(); } catch (e) { console.error("reputation li prefetch", e); }
          for (const c of cl || []) {
            if (c.local_incite_location_id || !ctx.locs) continue;
            const m = liMatch(c, ctx.locs);
            if (m?.sure && !(cl || []).some((o: any) => o.local_incite_location_id === m.loc.location_id)) {
              c.local_incite_location_id = m.loc.location_id;
              await supa.from("clients").update({ local_incite_location_id: m.loc.location_id }).eq("id", c.id);
            }
          }
        }
        const byId = new Map((cl || []).map((c: any) => [c.id, c]));
        return eachClient(ids, async (id) => {
          const c: any = byId.get(id);
          const g = hasGoogle ? await collectClient(supa, id) : null;
          const l = hasLi && ctx.locs && c.local_incite_location_id ? await collectLocalIncite(supa, c, ctx) : null;
          return { error: g?.error || l?.error || null };
        });
      })().then((r) => console.log("reputation collect_all", JSON.stringify(r).slice(0, 2000)))
        .catch((e) => console.error("reputation collect_all", e));
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(work); else await work;
      return json({ ok: true, background: true, clients: ids.length }, 202);
    }

    const clientId = String(body.client_id || "");
    if (!clientId) return json({ error: "client_id required" }, 400);

    if (action === "get") {
      const { data: c } = await supa.from("clients").select("id, name, url, market, gbp_place_id, local_incite_location_id").eq("id", clientId).maybeSingle();
      if (!c) return json({ error: "client not found" }, 404);
      const linked = new Set<string>(c.local_incite_location_id ? [clientId] : []);
      const sum = (await summaryFor(supa, [clientId], linked))[clientId];
      const { data: recent } = await supa.from("reputation_reviews").select("site, rating, author, text, published_at, review_url, first_seen_at")
        .eq("client_id", clientId).eq("source", c.local_incite_location_id ? "local_incite" : "google")
        .order("published_at", { ascending: false, nullsFirst: false }).limit(10);
      const { data: hist } = await supa.from("reputation_snapshots").select("captured_at, rating, review_count")
        .eq("client_id", clientId).eq("source", "google").not("rating", "is", null).order("captured_at", { ascending: false }).limit(90);
      return json({ ok: true, client: { name: c.name, market: c.market, place_id: c.gbp_place_id, li_location_id: c.local_incite_location_id },
        google_key_set: !!(await platformKey("GOOGLE_PLACES_API_KEY")), local_incite_key_set: !!(await platformKey("LOCAL_INCITE_API_KEY")),
        summary: sum, recent_reviews: recent || [], history: (hist || []).reverse() });
    }
    if (action === "li_locations") {
      const { data: c } = await supa.from("clients").select("name, url, local_incite_location_id").eq("id", clientId).maybeSingle();
      if (!c) return json({ error: "client not found" }, 404);
      const locs = await liLocations();
      const { data: taken } = await supa.from("clients").select("id, name, local_incite_location_id").not("local_incite_location_id", "is", null);
      const owner = new Map((taken || []).filter((t: any) => t.id !== clientId).map((t: any) => [t.local_incite_location_id, t.name]));
      const m = liMatch(c, locs);
      return json({ ok: true, current: c.local_incite_location_id, suggested: m?.loc.location_id || null,
        locations: locs.map((l: any) => ({ ...l, linked_to: owner.get(l.location_id) || null })).sort((a: any, b: any) => a.name.localeCompare(b.name)) });
    }
    if (action === "set_li_location") {
      const lid = body.location_id ? String(body.location_id).trim() : null;
      if (lid && !/^[A-Za-z0-9_-]{3,64}$/.test(lid)) return json({ error: "that doesn't look like a Local Incite location id" }, 400);
      const { data: c, error } = await supa.from("clients").update({ local_incite_location_id: lid }).eq("id", clientId).select("id, name, url, local_incite_location_id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, snapshot: lid ? await collectLocalIncite(supa, c) : null });
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
    if (action === "collect") {
      const { data: c } = await supa.from("clients").select("id, name, url, local_incite_location_id").eq("id", clientId).maybeSingle();
      if (!c) return json({ error: "client not found" }, 404);
      const snapshot = await collectClient(supa, clientId);
      const li_snapshot = c.local_incite_location_id ? await collectLocalIncite(supa, c) : null;
      return json({ ok: true, snapshot, li_snapshot });
    }
    return json({ error: "unhandled action" }, 400);
  } catch (e) {
    console.error("reputation", action, e);
    return json({ error: String((e as any)?.message || e).slice(0, 400) }, 500);
  }
});
