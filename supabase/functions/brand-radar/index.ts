// ============================================================================
//  brand-radar: AI citation tracking via Ahrefs Brand Radar.
// ----------------------------------------------------------------------------
//  Every client gets a Brand Radar report (its brand + domain, the local
//  competitors the audit found) and a handful of custom prompts built from
//  its services and city ("best tree service in Cedar Rapids, IA"). Ahrefs
//  asks those questions on the selected AI engines at the chosen frequency;
//  this function snapshots the answers into ai_visibility: questions asked
//  per engine, whether the brand was mentioned, which of its pages were
//  cited, and who else was cited. run-audit and generate-report read those
//  snapshots (report section 6 + Looker).
//
//  Cost: report/prompt management and custom-prompt data reads are free API
//  calls. Ahrefs bills the prompt CHECKS themselves (prompts x engines x
//  runs), so tracking starts OFF (app_settings.ai_tracking.enabled) and a
//  Super Admin turns it on in Team & access.
//
//  Actions (POST { action, ... }):
//    status                       any staff   settings + Ahrefs reachability
//    get          {client_id}     any staff   report id, prompts, latest snapshot
//    setup        {client_id}     SA / AM     create the report + prompts (idempotent)
//    set_prompts  {client_id, prompts[]}  SA / AM  replace the client's prompts
//    collect      {client_id}     any staff   snapshot the latest answers now
//    setup_all                    SA          backfill every active client (background)
//    collect_all                  SA/service  weekly snapshot of every tracked client (background)
//    apply_settings {settings}    SA          save settings + push frequency to every report
//  Secrets: AHREFS_API_KEY (already set for run-audit).
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

const VERSION = "1.0.1";
const AH = "https://api.ahrefs.com/v3";
const ALL_ENGINES = ["chatgpt", "google_ai_overviews", "google_ai_mode", "gemini", "perplexity", "copilot"];
const ENGINE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT", google_ai_overviews: "Google AI Overviews", google_ai_mode: "Google AI Mode",
  gemini: "Gemini", perplexity: "Perplexity", copilot: "Copilot", claude: "Claude", grok: "Grok",
};
const FREQS = ["daily", "weekly", "monthly"];
const DEFAULTS = { enabled: false, engines: ["chatgpt", "google_ai_overviews", "perplexity"], frequency: "weekly", prompts_per_client: 5, country: "us" };

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
const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase().replace(/^www\./, ""); } catch { return rootOf(u); } };
const onDomain = (url: string, root: string) => { const h = hostOf(url); return !!root && (h === root || h.endsWith("." + root)); };
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function ahrefs(method: string, path: string, query: Record<string, string> = {}, body?: unknown) {
  const key = (await platformKey("AHREFS_API_KEY"));
  if (!key) throw new Error("AHREFS_API_KEY is not set");
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(`${AH}/${path}${qs ? "?" + qs : ""}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const txt = await r.text();
  let data: any = null; try { data = JSON.parse(txt); } catch { /* non-JSON error page */ }
  if (!r.ok) throw new Error(`Ahrefs ${path} ${r.status}: ${String(data?.error || txt).slice(0, 240)}`);
  return data;
}

async function loadSettings(supa: any) {
  const { data } = await supa.from("app_settings").select("value").eq("key", "ai_tracking").maybeSingle();
  return cleanSettings(data?.value || {});
}
function cleanSettings(v: any) {
  const s: any = { ...DEFAULTS, ...(v || {}) };
  s.enabled = s.enabled === true;
  s.engines = (Array.isArray(s.engines) ? s.engines : DEFAULTS.engines).filter((e: string) => ALL_ENGINES.includes(e));
  if (!s.engines.length) s.engines = DEFAULTS.engines;
  if (!FREQS.includes(s.frequency)) s.frequency = "weekly";
  s.prompts_per_client = Math.min(Math.max(1, Number(s.prompts_per_client) || 5), 20);
  s.country = /^[a-z]{2}$/.test(String(s.country)) ? s.country : "us";
  return s;
}
const frequencyPlan = (s: any) => ALL_ENGINES.map((e) => ({ data_source: e, frequency: s.enabled && s.engines.includes(e) ? s.frequency : "off" }));

// What the latest audit learned about the business: services, type, city, local competitors.
async function clientContext(supa: any, clientId: string) {
  const { data: c } = await supa.from("clients").select("id, name, url, market, status, intake, brand_radar_report_id").eq("id", clientId).maybeSingle();
  if (!c) throw new Error("client not found");
  const { data: a } = await supa.from("audits").select("id, raw->business, raw->tradeArea, raw->competitorsDetail")
    .eq("client_id", clientId).order("run_at", { ascending: false }).limit(1).maybeSingle();
  const biz = (a as any)?.business || {};
  const trade = (a as any)?.tradeArea || {};
  const comps: string[] = ((a as any)?.competitorsDetail || []).map((x: any) => rootOf(x?.domain)).filter(Boolean);
  return { c, root: rootOf(c.url), biz, city: String(trade.primary || c.market || "").trim(), comps: [...new Set(comps)].slice(0, 5) };
}

// Plain-language questions a local customer would ask an AI assistant.
function buildPrompts(ctx: any, n: number): string[] {
  const city = ctx.city;
  // lowercase for mid-sentence use, but keep acronyms (IT, HVAC, CPA)
  const lc = (t: unknown) => String(t || "").trim().split(/\s+/).map((w) => /^[A-Z]{2,5}s?$/.test(w) ? w : w.toLowerCase()).join(" ");
  const services: string[] = (ctx.biz.services || []).map(lc).filter(Boolean);
  // The audit's trade label can be long ("tree service and arboriculture");
  // customers ask with the short form, so fall back to the lead service.
  const rawType = lc(ctx.biz.type).replace(/\s*(&|\band\b|\/|,).*$/, "").trim() || services[0] || "";
  const type = !rawType ? "" : /\b(company|provider|contractor|firm|agency|shop|services?|clinic|practice|dealer|store|studio|center|office)$/.test(rawType) ? rawType : `${rawType} company`;
  const firms = (svc: string) => `${svc.replace(/\s+services?$/, "")} companies`;
  const iv = ctx.c.intake || {};
  const kws: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const k = String(iv["kw" + i] || "").trim(); if (!k) continue;
    const loc = String(iv["kwl" + i] || "").trim() || city;
    kws.push(loc && !k.toLowerCase().includes(loc.split(",")[0].trim().toLowerCase()) ? `${k} in ${loc}` : k);
  }
  const out: string[] = [];
  const add = (p: string) => { if (p && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p.slice(0, 380)); };
  if (city) {
    if (type) add(`What is the best ${type} in ${city}?`);
    if (services[0]) add(`Who are the top-rated ${firms(services[0])} in ${city}?`);
    kws.slice(0, 2).forEach((k) => add(`Who is the best option for ${k}?`));
    if (services[1]) add(`I need ${services[1]} in ${city}. Who should I call?`);
    if (services[2]) add(`Can you recommend a reliable ${services[2]} provider near ${city}?`);
    if (type) add(`Which ${type} in ${city} has the best reviews?`);
    services.slice(3).forEach((s) => add(`Who offers the best ${s} in ${city}?`));
  } else kws.forEach((k) => add(`Who is the best option for ${k}?`));
  return out.slice(0, n);
}

async function setupClient(supa: any, clientId: string, s: any, overridePrompts?: string[]) {
  const ctx = await clientContext(supa, clientId);
  if (!ctx.root) throw new Error("client has no URL");
  let reportId = String(ctx.c.brand_radar_report_id || "").trim();
  let created = false;
  if (!reportId) {
    const res = await ahrefs("POST", "management/brand-radar-reports", {}, {
      name: `${ctx.c.name || ctx.root} (${ctx.root})`.slice(0, 120),
      brand: [{ names: [ctx.c.name || ctx.root], url_groups: [{ target: ctx.root, scope: "domain" }] }],
      competitors: ctx.comps.map((d) => ({ url_groups: [{ target: d, scope: "domain" }] })),
      prompts_frequency: frequencyPlan(s),
    });
    reportId = String(res?.reports?.[0]?.report_id || "");
    if (!reportId) throw new Error("Ahrefs created no report id");
    created = true;
    const { error } = await supa.from("clients").update({ brand_radar_report_id: reportId }).eq("id", clientId);
    if (error) throw new Error(`saving report id: ${error.message}`);
  }
  const existing = await ahrefs("GET", "management/brand-radar-prompts", { report_id: reportId });
  const have: string[] = (existing?.prompts || []).map((p: any) => String(p.prompt));
  let added: string[] = [];
  if (overridePrompts || !have.length) {
    const want = overridePrompts ?? buildPrompts(ctx, s.prompts_per_client);
    if (!want.length) throw new Error("no prompts could be built — run an audit first so the business type, services and city are known");
    if (overridePrompts) {
      const drop = have.filter((p) => !want.some((w) => w.toLowerCase() === p.toLowerCase()));
      if (drop.length) await ahrefs("PUT", "management/brand-radar-prompts-delete", { report_id: reportId }, { prompts: drop, countries: [s.country] });
    }
    added = want.filter((w) => !have.some((p) => p.toLowerCase() === w.toLowerCase()));
    if (added.length) await ahrefs("POST", "management/brand-radar-prompts", { report_id: reportId }, { prompts: added, countries: [s.country], tags: ["seo-platform"] });
  }
  const after = await ahrefs("GET", "management/brand-radar-prompts", { report_id: reportId });
  return { report_id: reportId, created, prompts: (after?.prompts || []).map((p: any) => p.prompt), added };
}

async function collectClient(supa: any, clientId: string, s: any) {
  const ctx = await clientContext(supa, clientId);
  const reportId = String(ctx.c.brand_radar_report_id || "").trim();
  if (!reportId) throw new Error("no Brand Radar report for this client — run setup first");
  const base = { report_id: reportId, data_source: s.engines.join(","), prompts: "custom" };
  const brandKeys = [norm(ctx.c.name), norm(ctx.root), norm(ctx.root.split(".")[0])].filter((k) => k.length >= 3);
  const isUs = (b: unknown) => { const n = norm(b); return !!n && brandKeys.some((k) => n === k || n.includes(k) || k.includes(n)); };
  const row: any = { client_id: clientId, report_id: reportId, engines: s.engines };
  try {
    const promptList = await ahrefs("GET", "management/brand-radar-prompts", { report_id: reportId });
    row.prompts_tracked = (promptList?.prompts || []).length;
    const res = await ahrefs("GET", "brand-radar/ai-responses", { ...base, select: "question,data_source,links,brand_sentiment,last_updated,country", limit: "1000" });
    const answers: any[] = res?.ai_responses || [];
    const perEngine: Record<string, any> = {};
    const perPrompt: Record<string, any> = {};
    const cited: Record<string, any> = {};
    const compCites: Record<string, number> = {};
    let mentioning = 0, citing = 0;
    for (const a of answers) {
      const eng = String(a.data_source || "");
      const links: any[] = Array.isArray(a.links) ? a.links : [];
      const mine = links.filter((l) => onDomain(l?.url, ctx.root));
      const mentioned = (a.brand_sentiment || []).some((b: any) => isUs(b?.brand)) || mine.length > 0;
      if (mentioned) mentioning++;
      if (mine.length) citing++;
      const pe = perEngine[eng] ||= { engine: eng, label: ENGINE_LABEL[eng] || eng, checked: 0, mentioned: 0, cited: 0 };
      pe.checked++; if (mentioned) pe.mentioned++; if (mine.length) pe.cited++;
      const q = String(a.question || "");
      const pp = perPrompt[q] ||= { question: q, engines: {} as Record<string, any> };
      pp.engines[eng] = { mentioned, cited: mine.length > 0, url: mine[0]?.url || null, date: a.last_updated || null };
      for (const l of mine) {
        const u = String(l.url);
        const cu = cited[u] ||= { url: u, title: l.title || null, responses: 0, engines: [] as string[] };
        cu.responses++; if (!cu.engines.includes(eng)) cu.engines.push(eng);
      }
      for (const l of links) for (const d of ctx.comps) if (onDomain(l?.url, d)) compCites[d] = (compCites[d] || 0) + 1;
    }
    row.responses_checked = answers.length;
    row.responses_mentioning = mentioning;
    row.responses_citing = citing;
    row.per_engine = s.engines.map((e: string) => perEngine[e] || { engine: e, label: ENGINE_LABEL[e] || e, checked: 0, mentioned: 0, cited: 0 });
    row.per_prompt = Object.values(perPrompt);
    row.cited_urls = Object.values(cited).sort((x: any, y: any) => y.responses - x.responses).slice(0, 50);
    row.competitor_citations = Object.entries(compCites).map(([domain, responses]) => ({ domain, responses })).sort((x, y) => y.responses - x.responses);
    if (answers.length) {
      try {
        const sov = await ahrefs("GET", "brand-radar/sov-overview", base);
        const rows: any[] = sov?.metrics || [];
        const ours = rows.find((r) => r.entity_type === "target") || rows.find((r) => isUs(r.brand));
        const top = rows.filter((r) => r.entity_type === "competitor").sort((x, y) => (y.share_of_voice || 0) - (x.share_of_voice || 0))[0];
        row.share_of_voice = ours?.share_of_voice ?? null;
        row.top_competitor = top?.brand ?? null;
        row.top_competitor_sov = top?.share_of_voice ?? null;
      } catch (e) { row.error = String(e).slice(0, 300); }
    }
  } catch (e) {
    row.error = String((e as any)?.message || e).slice(0, 500);
  }
  const { data, error } = await supa.from("ai_visibility").insert(row).select("id, captured_at").single();
  if (error) throw new Error(`saving snapshot: ${error.message}`);
  return { ...row, id: data.id, captured_at: data.captured_at };
}

async function eachClient(ids: string[], fn: (id: string) => Promise<unknown>, conc = 3) {
  const stats = { ok: 0, failed: 0, errors: [] as string[] };
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { await fn(id); stats.ok++; }
      catch (e) { stats.failed++; stats.errors.push(`${id}: ${String((e as any)?.message || e).slice(0, 160)}`); }
    }
  }));
  return stats;
}
function inBackground(label: string, work: Promise<unknown>) {
  const p = work.then((r) => console.log(label, JSON.stringify(r).slice(0, 2000))).catch((e) => console.error(label, e));
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p);
  return p;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const roles: Record<string, string[] | undefined> = {
    status: undefined, get: undefined, collect: undefined,
    setup: ["super_admin", "account_manager"], set_prompts: ["super_admin", "account_manager"],
    setup_all: ["super_admin"], collect_all: ["super_admin"], apply_settings: ["super_admin"],
  };
  if (!(action in roles)) return json({ error: `unknown action "${action}"` }, 400);
  const who = await gateCaller(req, roles[action]);
  if (who instanceof Response) return who;
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    const s = await loadSettings(supa);
    const clientId = String(body.client_id || "");

    if (action === "status") {
      let ahrefsOk = false, ahrefsError: string | null = null, reportsInAhrefs: number | null = null;
      try { const r = await ahrefs("GET", "management/brand-radar-reports"); ahrefsOk = true; reportsInAhrefs = (r?.reports || []).length; }
      catch (e) { ahrefsError = String((e as any)?.message || e); }
      const { data: cl } = await supa.from("clients").select("id, brand_radar_report_id").eq("status", "active");
      const tracked = (cl || []).filter((c: any) => c.brand_radar_report_id).length;
      const { data: last } = await supa.from("ai_visibility").select("captured_at").order("captured_at", { ascending: false }).limit(1).maybeSingle();
      const monthlyRuns = s.frequency === "daily" ? 30 : s.frequency === "weekly" ? 4.33 : 1;
      return json({ ok: true, version: VERSION, settings: s, ahrefs_ok: ahrefsOk, ahrefs_error: ahrefsError, reports_in_ahrefs: reportsInAhrefs,
        active_clients: (cl || []).length, clients_with_report: tracked, last_snapshot: last?.captured_at || null,
        est_checks_per_month: Math.round(tracked * s.prompts_per_client * s.engines.length * monthlyRuns) });
    }

    if (action === "apply_settings") {
      const clean = cleanSettings({ ...s, ...(body.settings || {}) });
      const { error: sErr } = await supa.from("app_settings").upsert({ key: "ai_tracking", value: clean });
      if (sErr) return json({ error: `saving settings: ${sErr.message}` }, 500);
      const { data: cl } = await supa.from("clients").select("id, brand_radar_report_id").not("brand_radar_report_id", "is", null);
      const ids = (cl || []).filter((c: any) => c.brand_radar_report_id).map((c: any) => String(c.brand_radar_report_id));
      const stats = await eachClient(ids, (rid) => ahrefs("PATCH", "management/brand-radar-reports", {}, { report_id: rid, prompts_frequency: frequencyPlan(clean) }), 4);
      return json({ ok: stats.failed === 0, settings: clean, reports_updated: stats.ok, failed: stats.failed, errors: stats.errors.slice(0, 10) });
    }

    if (action === "setup_all" || action === "collect_all") {
      const { data: cl } = await supa.from("clients").select("id, brand_radar_report_id").eq("status", "active");
      const ids = (cl || []).filter((c: any) => action === "setup_all" ? !c.brand_radar_report_id : !!c.brand_radar_report_id).map((c: any) => c.id);
      if (action === "collect_all" && !s.enabled && body.force !== true) return json({ ok: true, skipped: "tracking is off", clients: ids.length });
      const work = eachClient(ids, (id) => action === "setup_all" ? setupClient(supa, id, s) : collectClient(supa, id, s));
      inBackground(action, work);
      return json({ ok: true, background: true, clients: ids.length }, 202);
    }

    if (!clientId) return json({ error: "client_id required" }, 400);

    if (action === "get") {
      const { data: c } = await supa.from("clients").select("brand_radar_report_id").eq("id", clientId).maybeSingle();
      const rid = c?.brand_radar_report_id || null;
      let prompts: string[] = [], promptsError: string | null = null;
      if (rid) { try { prompts = ((await ahrefs("GET", "management/brand-radar-prompts", { report_id: rid }))?.prompts || []).map((p: any) => p.prompt); } catch (e) { promptsError = String((e as any)?.message || e); } }
      const { data: snap } = await supa.from("ai_visibility").select("*").eq("client_id", clientId).order("captured_at", { ascending: false }).limit(1).maybeSingle();
      return json({ ok: true, settings: s, report_id: rid, prompts, prompts_error: promptsError, latest: snap || null,
        suggested: rid ? null : buildPrompts(await clientContext(supa, clientId), s.prompts_per_client) });
    }
    if (action === "setup") return json({ ok: true, ...(await setupClient(supa, clientId, s)) });
    if (action === "set_prompts") {
      const list = (Array.isArray(body.prompts) ? body.prompts : []).map((p: any) => String(p).trim()).filter(Boolean).slice(0, 20);
      if (!list.length) return json({ error: "at least one prompt is required" }, 400);
      if (list.some((p: string) => p.length >= 400)) return json({ error: "each prompt must be under 400 characters" }, 400);
      return json({ ok: true, ...(await setupClient(supa, clientId, s, list)) });
    }
    if (action === "collect") return json({ ok: true, snapshot: await collectClient(supa, clientId, s) });
    return json({ error: "unhandled action" }, 400);
  } catch (e) {
    console.error("brand-radar", action, e);
    return json({ error: String((e as any)?.message || e).slice(0, 500) }, 500);
  }
});
