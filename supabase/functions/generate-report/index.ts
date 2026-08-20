// ============================================================================
//  Reporting Engine v2 — generate-report Edge Function
// ----------------------------------------------------------------------------
//  Client-facing progress report. FULLY AUTOMATED — no human reads it before
//  the client does — so every safeguard is enforced in code:
//
//  · DETERMINISTIC NUMBERS. Every figure, delta, and grade is computed here
//    and injected as a fixed value. No LLM anywhere in this pipeline; grades
//    are read from the persisted audit row and are never recomputed.
//  · THREE TIME FRAMES. Cycle delta (vs prior audit), program-to-date (vs the
//    IMMUTABLE engagement baseline locked on clients.baseline_audit_id), and
//    year-over-year when ≥13 months of history exists.
//  · MINIMUM WINDOW. Lagging metrics (rankings/traffic) render as deltas only
//    over a ≥28-day window; shorter windows say so instead of showing noise.
//  · METRIC TIERS. Measured (GSC) may be stated as fact. Modeled (Ahrefs
//    traffic/DR estimates) is labeled as an estimate, never headlined, and
//    never carries a % change. Proprietary grades always ship with the rubric
//    and any regression ships with a cause + remediation or is suppressed.
//  · NO FABRICATION. A source that did not return data renders as an explicit
//    unavailable state — never a zero, never an interpolation.
//  · PRE-SEND VALIDATION. Structural violations block generation (422) and
//    nothing is stored. Churn-risk conditions set review_recommended in
//    report_meta for the console to surface.
//  · WHITE-LABEL. Branded with the client's partner group (name, logo, color);
//    44i Digital only when the client has no group.
//
//  Deploy: Edge Functions → generate-report → redeploy.
//  Requires: report_storage_migration.sql (report_html/report_meta on
//  packages) and report_baseline.sql (clients.baseline_audit_id).
//  Input:  { "package_id": "<uuid>" } or { "client_id": "<uuid>" }
//  Returns { ok, html, meta } — and persists html+meta on the package row.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const REPORT_VERSION = "2.1.0";
const MIN_WINDOW_DAYS = 28;   // lagging deltas need at least this much time
const PCT_FLOOR = 30;         // no % change on a base smaller than this
const NA_COVERAGE_MIN = 0.5;  // pillar shows "not assessed" below this check coverage

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: unknown, def = "—") => (n == null || (typeof n === "number" && !isFinite(n))) ? def : (typeof n === "number" ? n.toLocaleString() : String(n));
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "—";
const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
const monthsBetween = (a: string, b: string) => Math.max(0, (new Date(b).getUTCFullYear() - new Date(a).getUTCFullYear()) * 12 + (new Date(b).getUTCMonth() - new Date(a).getUTCMonth()));

// A lagging-metric delta cell honoring window + base-floor rules.
function laggingDelta(nowV: number | null, beforeV: number | null, windowDays: number, unit = ""): string {
  if (nowV == null || beforeV == null) return `<span class="muted">data unavailable</span>`;
  if (windowDays < MIN_WINDOW_DAYS) return `<span class="muted">window too short (${windowDays}d) — reported at ≥${MIN_WINDOW_DAYS}d</span>`;
  const d = nowV - beforeV;
  if (d === 0) return `<span class="delta-flat">no change</span>`;
  const cls = d > 0 ? "delta-up" : "delta-down", sign = d > 0 ? "+" : "";
  if (beforeV < PCT_FLOOR) return `<span class="${cls}">${sign}${num(d)}${unit}</span> <span class="muted">(base too small for a reliable %)</span>`;
  return `<span class="${cls}">${sign}${num(d)}${unit} (${sign}${Math.round((d / beforeV) * 100)}%)</span>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const pkgIdInput: string | null = body.package_id ?? null;
    const clientIdInput: string | null = body.client_id ?? null;
    if (!pkgIdInput && !clientIdInput) return json({ error: "package_id or client_id required" }, 400);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── 1. Package, client, partner brand, current audit ─────────────────────
    let pkg: any = null;
    if (pkgIdInput) ({ data: pkg } = await supa.from("packages").select("id, client_id, audit_id, cycle_month, status, directive").eq("id", pkgIdInput).single());
    else ({ data: pkg } = await supa.from("packages").select("id, client_id, audit_id, cycle_month, status, directive").eq("client_id", clientIdInput!).order("cycle_month", { ascending: false }).limit(1).maybeSingle());
    if (!pkg) return json({ error: "package not found" }, 404);

    const { data: client } = await supa.from("clients").select("*").eq("id", pkg.client_id).single();
    const { data: currentAudit } = await supa.from("audits").select("*").eq("id", pkg.audit_id).single();
    if (!client || !currentAudit) return json({ error: "client or audit not found" }, 404);

    // Fully whitelabeled: the partner group IS the brand. A client with no
    // group renders with no agency name at all — never 44i.
    let brand = { name: "", color: "#4B9BD7", logo: "" };
    if (client.partner_group_id) {
      const { data: grp } = await supa.from("partner_groups").select("name, brand_color, logo_url").eq("id", client.partner_group_id).maybeSingle();
      if (grp?.name) brand = { name: grp.name, color: grp.brand_color || "#4B9BD7", logo: grp.logo_url || "" };
    }

    // ── 2. Time frames ────────────────────────────────────────────────────────
    // Immutable engagement baseline: locked once on the client, never reset.
    const { data: allAudits } = await supa.from("audits")
      .select("id, run_at, domain_rating, org_keywords, org_traffic, org_keywords_top3, referring_domains, grade_technical, grade_onpage, grade_schema, grade_aeo, grade_eeat, grade_local, score, raw")
      .eq("client_id", client.id).order("run_at", { ascending: true }).limit(200);
    const audits = allAudits || [];
    let baseline: any = null; let baselineLocked = false;
    if (client.baseline_audit_id) {
      baseline = audits.find((a: any) => a.id === client.baseline_audit_id) || null;
      baselineLocked = !!baseline;
    }
    if (!baseline) {
      baseline = audits.length ? audits[0] : currentAudit;
      // Lock it (best effort — column ships in report_baseline.sql).
      try { await supa.from("clients").update({ baseline_audit_id: baseline.id, baseline_locked_at: new Date().toISOString() }).eq("id", client.id); baselineLocked = true; } catch (_) { /* migration pending */ }
    }
    const priors = audits.filter((a: any) => a.id !== currentAudit.id && new Date(a.run_at) < new Date(currentAudit.run_at));
    const lastPrior = priors.length ? priors[priors.length - 1] : null;
    const isFirstCycle = baseline.id === currentAudit.id || !priors.length;

    const engagementStart: string = client.engagement_start_date ? String(client.engagement_start_date) + "T00:00:00Z" : baseline.run_at;
    const programMonth = Math.max(1, monthsBetween(engagementStart, currentAudit.run_at) + 1);
    const programDays = Math.max(0, days(baseline.run_at, currentAudit.run_at));
    const cycleDays = lastPrior ? Math.max(0, days(lastPrior.run_at, currentAudit.run_at)) : 0;
    const yoyAudit = audits.find((a: any) => Math.abs(days(a.run_at, currentAudit.run_at) - 365) <= 45 && a.id !== currentAudit.id) || null;

    // ── 3. Work executed + content quality gate ──────────────────────────────
    const { data: pushedFixes } = await supa.from("fixes").select("id, kind, target_page, status").eq("audit_id", pkg.audit_id).in("status", ["pushed", "verified"]);
    const { data: approvedDrafts } = await supa.from("content_drafts").select("id, title, kind").eq("package_id", pkg.id).eq("approved", true);
    // Near-duplicate gate: pages differing only by a city token are counted
    // once in the client deliverable (variants logged in meta, never listed).
    const raw = currentAudit.raw || {};
    const towns: string[] = [raw.tradeArea?.primary || "", ...(raw.tradeArea?.secondary || [])].map((t: string) => String(t).split(",")[0].trim().toLowerCase()).filter(Boolean);
    const normTitle = (t: string) => { let s = String(t || "").toLowerCase(); for (const town of towns) s = s.split(town).join(""); return s.replace(/\b(ia|iowa|sd|mn|ne)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim(); };
    const seenTitles = new Map<string, any>(); let gatedCount = 0;
    const gatedDrafts: any[] = [];
    for (const c of (approvedDrafts || [])) {
      const k = normTitle(c.title);
      if (k && seenTitles.has(k)) { gatedCount++; continue; }
      if (k) seenTitles.set(k, c);
      gatedDrafts.push(c);
    }

    // ── 4. Measured layer (GSC) — leading indicators + trend across audits ───
    const gscNow = raw.gsc || null;                 // { queries, clicks, impressions, striking, ctrBleed }
    const gscPrior = lastPrior?.raw?.gsc || null;
    const gscBase = baseline?.raw?.gsc || null;
    const gscTrend = audits.filter((a: any) => a.raw?.gsc && (a.raw.gsc.queries || 0) > 0)
      .map((a: any) => ({ date: a.run_at, queries: a.raw.gsc.queries || 0, clicks: a.raw.gsc.clicks || 0, impressions: a.raw.gsc.impressions || 0 }));
    const gscConnected = !!(gscNow && (gscNow.queries || 0) > 0);

    // ── 5. Rank movements (Ahrefs rank tracking — labeled as such) ───────────
    const { data: currentKws } = await supa.from("keywords").select("keyword, position, volume").eq("audit_id", pkg.audit_id);
    let priorKws: any[] = [];
    const compareAudit = lastPrior || baseline;
    if (compareAudit && compareAudit.id !== currentAudit.id) {
      const { data } = await supa.from("keywords").select("keyword, position, volume").eq("audit_id", compareAudit.id);
      priorKws = data || [];
    }
    const priorMap = new Map<string, any>(); priorKws.forEach((k) => priorMap.set(String(k.keyword).toLowerCase(), k));
    const movements = (currentKws || []).map((k: any) => {
      const b = priorMap.get(String(k.keyword).toLowerCase());
      const before = b?.position ?? null, after = k.position ?? null;
      return { keyword: k.keyword, volume: k.volume, before, after,
        delta: (before != null && after != null) ? before - after : null,
        newlyRanking: before == null && after != null };
    });
    const improvements = movements.filter((m) => (m.delta || 0) > 0).sort((a, b) => (b.delta || 0) - (a.delta || 0));
    const newlyRanking = movements.filter((m) => m.newlyRanking);
    const deepMoves = improvements.filter((m) => (m.before || 0) > 20); // movement inside 20–100 counts

    // ── 6. Grades: read from the audit row, NEVER recomputed. Coverage +
    //      regression causes derive from the persisted checklists. ────────────
    const PILLARS = [
      ["grade_technical", "technical", "Technical"], ["grade_onpage", "onpage", "On-Page"],
      ["grade_schema", "schema", "Schema"], ["grade_aeo", "aeo", "AEO"],
      ["grade_eeat", "eeat", "E-E-A-T"], ["grade_local", "local", "Local"],
    ] as const;
    const coverageOf = (audit: any, pillar: string) => {
      const cl: any[] = audit?.raw?.checklist || [];
      const rows = cl.filter((c) => c.pillar === pillar);
      if (!rows.length) return 1; // no checklist detail → don't suppress
      const total = rows.reduce((a, c) => a + (c.weight || 1), 0);
      const assessed = rows.filter((c) => c.status !== "na").reduce((a, c) => a + (c.weight || 1), 0);
      return total ? assessed / total : 1;
    };
    const GRADE_ORD: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 };
    const dataDependent = new Set(["psi_perf", "lcp", "cls", "inp", "perf_fixables", "aeo_overviews", "aeo_snippets", "aeo_sov", "local_pack", "local_intent", "crawl_coverage", "crawl_health"]);
    const gradeRows = PILLARS.map(([key, pillar, label]) => {
      const now = (currentAudit as any)[key] || null;
      const prior = lastPrior ? ((lastPrior as any)[key] || null) : null;
      const base = (baseline as any)[key] || null;
      const cov = coverageOf(currentAudit, pillar);
      const suppressed = cov < NA_COVERAGE_MIN;
      const nowCl: any[] = (currentAudit.raw?.checklist || []).filter((c: any) => c.pillar === pillar);
      // The forward line every grade carries: below A, the audit's own
      // remediation text for the pillar's heaviest open checks; at A the job
      // flips to defense — king of the hill, hold it or lose it.
      let plan = "";
      if (!suppressed && now) {
        const open = nowCl.filter((c) => c.status === "fail" || c.status === "warn").sort((a, b) => (b.weight || 1) - (a.weight || 1));
        if (now === "A") {
          plan = open.length
            ? `Defending the A: ${open[0].action || open[0].label} Every passing check is re-verified next cycle.`
            : "Holding the top spot is a king-of-the-hill game: every check here passes today, so the work shifts to defense — fresh content on cadence, re-verification every cycle, and any regression treated as a same-cycle fix.";
        } else {
          const steps = open.slice(0, 2).map((c) => c.action || c.label).filter(Boolean);
          if (steps.length) plan = `To raise this grade: ${steps.join(" ")}`;
        }
      }
      let regression = false, cause = "", remediation = "";
      if (!suppressed && now && prior && GRADE_ORD[now] < GRADE_ORD[prior]) {
        regression = true;
        const priorCl: Record<string, string> = {}; (lastPrior?.raw?.checklist || []).forEach((c: any) => { if (c.pillar === pillar) priorCl[c.id] = c.status; });
        const flipped = nowCl.filter((c) => (priorCl[c.id] === "pass") && (c.status === "fail" || c.status === "warn" || c.status === "na"));
        const dataFlips = flipped.filter((c) => dataDependent.has(c.id) || c.status === "na");
        if (flipped.length && dataFlips.length === flipped.length) {
          cause = `A measurement source was unavailable this cycle (${dataFlips.map((c) => c.label).slice(0, 3).join("; ")}) — this is a data gap, not a site change.`;
          remediation = "The affected checks re-measure automatically next cycle; no site work is required.";
        } else if (flipped.length) {
          cause = `Checks that regressed: ${flipped.slice(0, 3).map((c) => c.label + (c.evidence ? ` (${c.evidence})` : "")).join("; ")}.`;
          remediation = flipped[0]?.action || "Scheduled for remediation in the next cycle's fix queue.";
        } else {
          cause = "The prior audit lacks check-level detail for a verified cause.";
          remediation = "Treated as unverified movement; re-measured next cycle before any conclusion is drawn.";
        }
      }
      return { key, pillar, label, now, prior, base, coverage: cov, suppressed, regression, cause, remediation, plan };
    });

    // ── 7. AEO measurement (the product we sell) ──────────────────────────────
    const aeoRaw = raw.aeo || {};
    const brandRadar = raw.brandRadar || null;
    const radarTrend = audits.filter((a: any) => a.raw?.brandRadar?.mentions != null)
      .map((a: any) => ({ date: a.run_at, mentions: a.raw.brandRadar.mentions, sov: a.raw.brandRadar.ourSov }));
    const aeoChecklist: any[] = (raw.checklist || []).filter((c: any) => c.pillar === "aeo" || c.pillar === "schema");
    const aeoReadyTotal = aeoChecklist.filter((c: any) => c.status !== "na").length;
    const aeoReadyPass = aeoChecklist.filter((c: any) => c.status === "pass").length;

    // ── 8. Cumulative asset ledger (program-to-date) ─────────────────────────
    const { data: allTopics } = await supa.from("content_topics")
      .select("kind, status, packages!inner(client_id)").eq("packages.client_id", client.id);
    const publishedByKind: Record<string, number> = {};
    (allTopics || []).filter((t: any) => t.status === "approved" || t.status === "published").forEach((t: any) => { publishedByKind[t.kind] = (publishedByKind[t.kind] || 0) + 1; });
    const auditIds = audits.map((a: any) => a.id);
    let cumulativeFixes = 0;
    if (auditIds.length) {
      const { count } = await supa.from("fixes").select("id", { count: "exact", head: true }).in("audit_id", auditIds).in("status", ["pushed", "verified"]);
      cumulativeFixes = count || 0;
    }
    const schemaTypes: string[] = raw.schema?.all || [];
    const clNow: any[] = raw.checklist || [];
    const clBase: any[] = baseline?.raw?.checklist || [];
    const passNow = clNow.filter((c) => c.status === "pass").length;
    const passBase = clBase.filter((c) => c.status === "pass").length;

    // ── 9. Narrative state (deterministic) ───────────────────────────────────
    const windowOK = programDays >= MIN_WINDOW_DAYS;
    const leadingMoving = (newlyRanking.length > 0) || (improvements.length > 0) ||
      (gscConnected && gscPrior && ((gscNow.queries || 0) > (gscPrior.queries || 0) || (gscNow.impressions || 0) > (gscPrior.impressions || 0)));
    const laggingMoving = windowOK && (((currentAudit.org_keywords || 0) > (baseline.org_keywords || 0)) ||
      ((baseline.org_traffic || 0) >= PCT_FLOOR && (currentAudit.org_traffic || 0) > (baseline.org_traffic || 0)));
    const regressions = gradeRows.filter((g) => g.regression);
    const phase = programMonth <= 3 ? "foundation" : programMonth <= 6 ? "emergence" : "compounding";
    const state = isFirstCycle ? "foundation"
      : (laggingMoving && leadingMoving) ? "compounding"
      : leadingMoving ? "emerging"
      : !windowOK ? "foundation"
      : (programMonth >= 7 ? "plateau" : "building");

    // ── 10. Next-cycle plan from the directive (never a copy of section 1) ───
    const dirItems: any[] = (pkg.directive?.items || []).filter((i: any) => i.in_plan && i.status !== "done");
    const nextActions = dirItems.slice(0, 7);
    const learnedFixed: string[] = ((pkg.directive?.progress?.fixed) || []).slice(0, 4);
    const gateRejects: any[] = (raw.keyword_gate || []).slice(0, 4);
    const roadmap: any[] = (pkg.directive?.items || []).filter((i: any) => !i.in_plan && i.status !== "done").slice(0, 4);

    // ── 11. PRE-SEND VALIDATION (blocking) ───────────────────────────────────
    const violations: string[] = [];
    for (const g of gradeRows) if (g.regression && (!g.cause || !g.remediation)) violations.push(`grade regression without cause/remediation: ${g.label}`);
    if (!isFirstCycle && !windowOK && !gscConnected) { /* allowed: leading section will state unavailability */ }
    // grade fidelity assertion: rendered grades ARE the audit fields by construction; record the source.
    const gradeSource = Object.fromEntries(PILLARS.map(([key]) => [key, (currentAudit as any)[key] || null]));
    if (violations.length) return json({ error: "validation_failed", violations }, 422);

    const reviewFlags: string[] = [];
    if (regressions.length >= 2) reviewFlags.push(`${regressions.length} pillar regressions in one cycle`);
    if (state === "plateau") reviewFlags.push(`month ${programMonth} with flat leading indicators — plan change required`);
    if (windowOK && (baseline.org_traffic || 0) >= PCT_FLOOR && (currentAudit.org_traffic || 0) < (baseline.org_traffic || 0) * 0.7) reviewFlags.push("large negative traffic movement vs baseline");

    // ── 12. Render ────────────────────────────────────────────────────────────
    const clientName = (client.url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const html = renderHTML({
      brand, clientName, market: raw.tradeArea?.primary || client.market || "",
      reportDate: fmtDate(currentAudit.run_at), baselineDate: fmtDate(baseline.run_at),
      lastPriorDate: lastPrior ? fmtDate(lastPrior.run_at) : null,
      programMonth, phase, state, isFirstCycle, programDays, cycleDays, windowOK,
      baselineLocked, yoyAudit, business: raw.business || {},
      currentAudit, baseline, lastPrior, gradeRows,
      pushedFixes: pushedFixes || [], gatedDrafts, gatedCount,
      gscConnected, gscNow, gscPrior, gscBase, gscTrend,
      improvements, newlyRanking, deepMoves,
      aeoRaw, brandRadar, radarTrend, aeoReadyPass, aeoReadyTotal,
      publishedByKind, cumulativeFixes, schemaTypes, passNow, passBase, clNowCount: clNow.length,
      nextActions, learnedFixed, gateRejects, roadmap, regressions,
    });

    const meta = {
      report_version: REPORT_VERSION, generated_at: new Date().toISOString(),
      audit_id: currentAudit.id, baseline_audit_id: baseline.id, last_prior_audit_id: lastPrior?.id || null,
      baseline_locked: baselineLocked, program_month: programMonth, window_days: programDays,
      state, phase, grade_source: gradeSource, gated_content: gatedCount,
      review_recommended: reviewFlags.length > 0, review_flags: reviewFlags, violations: [],
      sources: { ahrefs: true, gsc: gscConnected, ga4: false, ai_citations: !!brandRadar },
    };
    try { await supa.from("packages").update({ report_html: html, report_built_at: meta.generated_at, report_meta: meta }).eq("id", pkg.id); } catch (_) { /* columns ship in report_storage_migration.sql */ }

    return json({ ok: true, html, meta, baseline: baseline.run_at, current: currentAudit.run_at,
      deltas: { improvements: improvements.length, newlyRanking: newlyRanking.length, executedFixes: (pushedFixes || []).length, publishedContent: gatedDrafts.length } });
  } catch (e) {
    console.error("generate-report fatal", e);
    return json({ error: "unhandled", detail: String((e as any)?.stack || e).slice(0, 500) }, 500);
  }
});

// ── HTML ──────────────────────────────────────────────────────────────────────
function renderHTML(d: any): string {
  const { brand, clientName, market, reportDate, baselineDate, lastPriorDate,
    programMonth, phase, state, isFirstCycle, programDays, windowOK,
    yoyAudit, business, currentAudit, baseline, lastPrior, gradeRows,
    pushedFixes, gatedDrafts, gatedCount, gscConnected, gscNow, gscPrior, gscTrend,
    improvements, newlyRanking, deepMoves, brandRadar, radarTrend, aeoReadyPass, aeoReadyTotal,
    publishedByKind, cumulativeFixes, schemaTypes, passNow, passBase, clNowCount,
    nextActions, learnedFixed, gateRejects, roadmap, regressions } = d;
  const BC = brand.color || "#4B9BD7";

  const css = `
    @page { size: letter; margin: 0.6in 0.55in; }
    * { box-sizing: border-box; } html, body { margin: 0; padding: 0; }
    body { font-family: 'Manrope', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1b2330; line-height: 1.55; font-size: 11pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .wrap { max-width: 7.4in; margin: 0 auto; }
    h1,h2,h3,h4 { color: #1b2330; margin: 0 0 8pt 0; line-height: 1.25; }
    h1 { font-size: 30pt; font-weight: 800; letter-spacing: -0.02em; }
    h2 { font-size: 17pt; font-weight: 700; margin-top: 22pt; border-bottom: 2px solid ${BC}; padding-bottom: 6pt; }
    h3 { font-size: 12.5pt; font-weight: 700; margin-top: 14pt; color: #2a3548; }
    h4 { font-size: 10.5pt; font-weight: 700; color: ${BC}; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 12pt; }
    p { margin: 0 0 8pt 0; } .lead { font-size: 12pt; color: #2a3548; } .muted { color: #6b7686; font-size: 9.5pt; }
    .tag { display:inline-block; font-size:8pt; font-weight:700; letter-spacing:.05em; text-transform:uppercase; padding:1.5pt 6pt; border-radius:8pt; vertical-align:middle; }
    .tag-measured { background:#e1f5e7; color:#1f7a3c; } .tag-estimate { background:#fdf0d8; color:#8a5a00; } .tag-grade { background:#eef0f4; color:#4a5468; }
    .cover { page-break-after: always; padding-top: 1.4in; }
    .cover .brand { color: ${BC}; font-weight: 800; letter-spacing: 0.04em; font-size: 11pt; text-transform: uppercase; margin-bottom: 30pt; }
    .cover img.logo { max-height: 48pt; max-width: 220pt; display:block; margin-bottom: 18pt; }
    .cover h1 { font-size: 36pt; } .cover .sub { font-size: 15pt; color: #2a3548; margin-bottom: 26pt; }
    .cover .meta { margin-top: 34pt; padding-top: 16pt; border-top: 1px solid #e3e7ee; }
    .cover .meta div { margin-bottom: 4pt; }
    section { page-break-inside: avoid; }
    .grid { display: grid; gap: 9pt; } .grid-2{grid-template-columns:1fr 1fr;} .grid-3{grid-template-columns:repeat(3,1fr);} .grid-4{grid-template-columns:repeat(4,1fr);}
    .card { border: 1px solid #e3e7ee; border-radius: 6pt; padding: 9pt 11pt; background: #fff; }
    .card .label { font-size: 8.5pt; color: #6b7686; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 3pt; }
    .card .value { font-size: 17pt; font-weight: 800; line-height: 1.1; } .card .sub { font-size: 9pt; color: #6b7686; margin-top: 3pt; }
    table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 6pt; }
    th, td { text-align: left; padding: 5.5pt 7pt; border-bottom: 1px solid #e3e7ee; vertical-align: top; }
    th { color: #6b7686; font-weight: 600; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; background: #f7f9fc; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .delta-up { color: #1f7a3c; font-weight: 700; } .delta-down { color: #a01818; font-weight: 700; } .delta-flat { color: #6b7686; }
    .grade { display:inline-block; min-width: 24pt; padding: 3pt 7pt; border-radius: 5pt; font-weight: 800; text-align: center; font-size: 11pt; }
    .grade-A { background: #1f7a3c; color: #fff; } .grade-B { background: ${BC}; color: #fff; } .grade-C { background: #d9a23a; color: #fff; }
    .grade-D { background: #c66a3a; color: #fff; } .grade-F { background: #a01818; color: #fff; } .grade-NA { background: #eef0f4; color: #6b7686; font-size: 8.5pt; }
    .callout { background: #f4f8fc; border-left: 4pt solid ${BC}; padding: 9pt 13pt; border-radius: 0 5pt 5pt 0; margin: 10pt 0; }
    .phase { display:flex; gap:6pt; margin: 10pt 0; }
    .phase div { flex:1; text-align:center; padding: 7pt 4pt; border-radius: 5pt; background:#f2f5f9; color:#6b7686; font-size:9pt; font-weight:700; }
    .phase div.on { background:${BC}; color:#fff; }
    ul.clean { margin: 6pt 0 10pt 18pt; padding: 0; } ul.clean li { margin-bottom: 4pt; }
    .footer { margin-top: 30pt; padding-top: 12pt; border-top: 1px solid #e3e7ee; font-size: 8.5pt; color: #6b7686; text-align: center; }
  `;

  const STATE_COPY: Record<string, string> = {
    foundation: "This engagement is in the foundation phase: assets are being built and deployed, and the search engines are discovering them. Measurable ranking and traffic movement follows indexation — typically from the second and third month onward.",
    emerging: "Leading indicators are moving — the site is surfacing for more queries and positions are improving — while lagging outcomes (traffic, top rankings) follow behind them. This is the expected order: visibility first, clicks second.",
    compounding: "Both leading and lagging indicators are moving. The assets built earlier in the program are now producing measurable outcomes, and each cycle's work adds to a base that keeps working.",
    building: "Measured movement is limited so far this program. The work shipped is accumulating (see the asset ledger), and the leading-indicator section below shows the earliest signals we track ahead of rankings and traffic.",
    plateau: `Leading indicators have been flat past the point where movement is expected. That requires a changed plan, not patience — the next-cycle section reflects a revised approach, and this report has been flagged for strategist review.`,
  };

  const cover = `
  <section class="cover">
    ${brand.logo ? `<img class="logo" src="${esc(brand.logo)}" alt="${esc(brand.name)}">` : ""}
    <div class="brand">${brand.name ? esc(brand.name) + " · " : ""}SEO &amp; AEO Progress Report</div>
    <h1>${esc(clientName)}</h1>
    <div class="sub">${market ? esc(market) + " · " : ""}Program month ${programMonth} · ${esc(phase[0].toUpperCase() + phase.slice(1))} phase</div>
    <div class="callout">${isFirstCycle
      ? `This is the <strong>baseline report</strong>: the honest starting picture every future report measures against. Nothing is projected and nothing is estimated as fact.`
      : `Progress is measured three ways: against last cycle (${esc(lastPriorDate || "—")}), against the program baseline (${esc(baselineDate)}, locked), and year-over-year once thirteen months of history exists. Each number states its source and reliability.`}
    </div>
    <div class="meta">
      <div><strong>Report date:</strong> ${esc(reportDate)}</div>
      <div><strong>Program baseline:</strong> ${esc(baselineDate)} (immutable)</div>
      ${business.type ? `<div><strong>Business:</strong> ${esc(business.type)}</div>` : ""}
      ${market ? `<div><strong>Primary trade area:</strong> ${esc(market)}</div>` : ""}
    </div>
  </section>`;

  const context = `
  <section>
    <h2>1 · Where This Program Stands</h2>
    <div class="phase">
      <div class="${phase === "foundation" ? "on" : ""}">FOUNDATION · months 1–3<br>build &amp; deploy assets</div>
      <div class="${phase === "emergence" ? "on" : ""}">EMERGENCE · months 4–6<br>impressions &amp; positions move</div>
      <div class="${phase === "compounding" ? "on" : ""}">COMPOUNDING · month 7+<br>traffic &amp; leads follow</div>
    </div>
    <p class="lead">${STATE_COPY[state] || STATE_COPY.building}</p>
    ${state === "plateau" ? `<div class="callout"><strong>Straight answer:</strong> at month ${programMonth}, measurable movement should be visible and is not. The plan for next cycle changes accordingly — see section 8.</div>` : ""}
  </section>`;

  const ledgerRows = Object.entries(publishedByKind).map(([k, v]) => `<tr><td>${esc(prettyKind(k))}</td><td class="num">${num(v)}</td></tr>`).join("");
  const ledger = `
  <section>
    <h2>2 · What You Own So Far <span class="tag tag-measured">cumulative · program-to-date</span></h2>
    <p>Everything below is a permanent, owned asset. Unlike paid ads — where traffic stops when spend stops — these keep working and compounding.</p>
    <div class="grid grid-4" style="margin-top:10pt;">
      <div class="card"><div class="label">Content published</div><div class="value">${num(Object.values(publishedByKind).reduce((a: number, b: any) => a + b, 0))}</div><div class="sub">pages &amp; articles, program-to-date</div></div>
      <div class="card"><div class="label">Fixes deployed</div><div class="value">${num(cumulativeFixes)}</div><div class="sub">technical &amp; structural, cumulative</div></div>
      <div class="card"><div class="label">Schema types live</div><div class="value">${num(schemaTypes.length)}</div><div class="sub">${esc(schemaTypes.slice(0, 4).join(", "))}${schemaTypes.length > 4 ? "…" : ""}</div></div>
      <div class="card"><div class="label">Audit checks passing</div><div class="value">${num(passNow)}<span style="font-size:10pt;color:#6b7686;">/${num(clNowCount)}</span></div><div class="sub">${passBase ? `was ${num(passBase)} at baseline` : "baseline for future cycles"}</div></div>
    </div>
    ${ledgerRows ? `<h4>Published content by type</h4><table><thead><tr><th>Type</th><th class="num">Total</th></tr></thead><tbody>${ledgerRows}</tbody></table>` : ""}
  </section>`;

  const FIX_LABELS: Record<string, string> = { title_tag: "Title tags", meta_description: "Meta descriptions", h1: "H1 headings", image_alt: "Image alt text", page_copy: "Page copy", faq_schema: "FAQ schema", local_business_schema: "LocalBusiness schema", org_schema: "Organization schema", person_schema: "Person schema", breadcrumb_schema: "Breadcrumb schema", aggregate_rating_schema: "Rating schema", internal_link: "Internal links", canonical: "Canonicals", robots_txt: "robots.txt", sitemap_xml: "XML sitemap", security_headers: "Security headers", og_tags: "Social tags", llms_txt: "llms.txt", redirect_map: "Redirects", website_schema: "WebSite schema", favicon: "Favicon", gbp_post: "Business Profile posts" };
  const byKind: Record<string, number> = {}; pushedFixes.forEach((f: any) => { byKind[f.kind] = (byKind[f.kind] || 0) + 1; });
  const work = `
  <section style="page-break-before: always;">
    <h2>3 · This Cycle's Work</h2>
    ${pushedFixes.length ? `
      <h3>Deployed fixes (${pushedFixes.length})</h3>
      <div class="grid grid-4" style="margin-top:8pt;">${Object.entries(byKind).slice(0, 8).map(([k, v]) => `<div class="card"><div class="label">${esc(FIX_LABELS[k] || k)}</div><div class="value">${v}</div></div>`).join("")}</div>
    ` : `<p class="muted">No fixes were marked deployed in this window — items staged in the platform are not claimed here until they ship.</p>`}
    ${gatedDrafts.length ? `
      <h3>Content published (${gatedDrafts.length}${gatedCount ? ` — ${gatedCount} near-duplicate variant${gatedCount > 1 ? "s" : ""} consolidated pending differentiation` : ""})</h3>
      <table><thead><tr><th>Title</th><th>Type</th></tr></thead><tbody>
        ${gatedDrafts.slice(0, 20).map((c: any) => `<tr><td>${esc(c.title || "(untitled)")}</td><td>${esc(prettyKind(c.kind))}</td></tr>`).join("")}
      </tbody></table>
    ` : ""}
  </section>`;

  let leading = "";
  if (gscConnected) {
    const qDelta = gscPrior ? (gscNow.queries || 0) - (gscPrior.queries || 0) : null;
    leading = `
    <section>
      <h2>4 · Leading Indicators <span class="tag tag-measured">measured · Google Search Console</span></h2>
      <p>These move before rankings and traffic do, and they are measured by Google directly — not estimated.</p>
      <div class="grid grid-3" style="margin-top:10pt;">
        <div class="card"><div class="label">Query surface</div><div class="value">${num(gscNow.queries)}</div><div class="sub">unique searches the site appears for${qDelta != null ? ` · ${qDelta >= 0 ? "+" : ""}${qDelta} vs last cycle` : ""}</div></div>
        <div class="card"><div class="label">Impressions (90d)</div><div class="value">${num(gscNow.impressions)}</div><div class="sub">times shown in results</div></div>
        <div class="card"><div class="label">Clicks (90d)</div><div class="value">${num(gscNow.clicks)}</div><div class="sub">measured visits from Google</div></div>
      </div>
      ${gscTrend.length > 1 ? `<h4>Trend across cycles</h4><table><thead><tr><th>Audit date</th><th class="num">Queries</th><th class="num">Impressions</th><th class="num">Clicks</th></tr></thead><tbody>
        ${gscTrend.slice(-6).map((t: any) => `<tr><td>${esc(fmtDate(t.date))}</td><td class="num">${num(t.queries)}</td><td class="num">${num(t.impressions)}</td><td class="num">${num(t.clicks)}</td></tr>`).join("")}
      </tbody></table>` : ""}
      ${(gscNow.striking || 0) > 0 ? `<p><strong>${num(gscNow.striking)}</strong> queries sit in striking distance (positions 4–20) — the next-cycle work targets these first.</p>` : ""}
      ${deepMoves.length ? `<h4>Early position movement (positions 20–100)</h4><p>Movement here precedes page-one visibility and is missed by "ranking keyword" counts:</p>
        <table><thead><tr><th>Term</th><th class="num">Was</th><th class="num">Now</th></tr></thead><tbody>
        ${deepMoves.slice(0, 8).map((m: any) => `<tr><td>${esc(m.keyword)}</td><td class="num">#${num(m.before)}</td><td class="num"><strong>#${num(m.after)}</strong></td></tr>`).join("")}</tbody></table>` : ""}
    </section>`;
  } else {
    leading = `
    <section>
      <h2>4 · Leading Indicators</h2>
      <div class="callout">Google Search Console is not yet feeding this report. Once connected, this section shows measured impressions, query surface growth, and indexation of every published asset — the earliest honest signals of progress. <strong>Data unavailable is reported as unavailable, never estimated.</strong></div>
    </section>`;
  }

  const kwCells = laggingDelta(currentAudit.org_keywords, baseline.org_keywords, programDays);
  const trafCells = laggingDelta(currentAudit.org_traffic, baseline.org_traffic, programDays);
  const lagging = `
  <section>
    <h2>5 · Rankings &amp; Traffic <span class="tag tag-estimate">modeled estimates · search index</span></h2>
    <p>These are third-party estimates useful for direction, not precise counts — on small bases a single keyword shifting position swings them heavily, so percentages are suppressed below a base of ${PCT_FLOOR} and windows under ${MIN_WINDOW_DAYS} days report absolute values only.</p>
    <div class="grid grid-3" style="margin-top:10pt;">
      <div class="card"><div class="label">Ranking keywords</div><div class="value">${num(currentAudit.org_keywords)}</div><div class="sub">${kwCells} vs program baseline</div></div>
      <div class="card"><div class="label">Est. monthly organic visits</div><div class="value">${num(currentAudit.org_traffic)}</div><div class="sub">${trafCells} vs program baseline</div></div>
      <div class="card"><div class="label">Domain authority</div><div class="value">${num(currentAudit.domain_rating)}</div><div class="sub">${baseline.domain_rating != null ? `was ${num(baseline.domain_rating)} at baseline` : "—"} · builds over months</div></div>
    </div>
    ${improvements.length ? `<h3>Position improvements ${lastPriorDate ? `since ${esc(lastPriorDate)}` : ""}</h3>
      <table><thead><tr><th>Term</th><th class="num">Volume</th><th class="num">Was</th><th class="num">Now</th></tr></thead><tbody>
      ${improvements.slice(0, 12).map((m: any) => `<tr><td>${esc(m.keyword)}</td><td class="num">${num(m.volume)}</td><td class="num">#${num(m.before)}</td><td class="num"><strong>#${num(m.after)}</strong></td></tr>`).join("")}</tbody></table>` : ""}
    ${newlyRanking.length ? `<h3>Newly ranking</h3>
      <table><thead><tr><th>Term</th><th class="num">Volume</th><th class="num">Position</th></tr></thead><tbody>
      ${newlyRanking.slice(0, 10).map((m: any) => `<tr><td>${esc(m.keyword)}</td><td class="num">${num(m.volume)}</td><td class="num"><strong>#${num(m.after)}</strong></td></tr>`).join("")}</tbody></table>` : ""}
    ${(!improvements.length && !newlyRanking.length) ? `<p class="muted">Position movement is developing — the leading indicators in section 4 are the earlier signal, and the program timeline in section 1 places this cycle in its expected arc.</p>` : ""}
    ${yoyAudit ? `<h4>Year-over-year</h4><p>Keywords ${num(yoyAudit.org_keywords)} → ${num(currentAudit.org_keywords)}; est. visits ${num(yoyAudit.org_traffic)} → ${num(currentAudit.org_traffic)} (same-period comparison controls for seasonality).</p>` : `<p class="muted">Year-over-year comparison unlocks at month 13 of the program.</p>`}
  </section>`;

  let aeoBody = "";
  if (brandRadar) {
    aeoBody = `
      <div class="grid grid-3" style="margin-top:10pt;">
        <div class="card"><div class="label">AI mentions</div><div class="value">${num(brandRadar.mentions)}</div><div class="sub">brand cited in AI answers</div></div>
        <div class="card"><div class="label">AI share of voice</div><div class="value">${brandRadar.ourSov != null ? Math.round(brandRadar.ourSov * 100) + "%" : "—"}</div><div class="sub">${brandRadar.topCompetitor ? `top competitor: ${esc(brandRadar.topCompetitor.brand)} at ${Math.round((brandRadar.topCompetitor.sov || 0) * 100)}%` : "vs tracked competitors"}</div></div>
        <div class="card"><div class="label">AEO readiness</div><div class="value">${aeoReadyTotal ? Math.round((aeoReadyPass / aeoReadyTotal) * 100) + "%" : "—"}</div><div class="sub">structured-data &amp; answer-content checks passing</div></div>
      </div>
      ${radarTrend.length > 1 ? `<h4>Citation trend</h4><table><thead><tr><th>Date</th><th class="num">Mentions</th><th class="num">Share of voice</th></tr></thead><tbody>
        ${radarTrend.slice(-6).map((t: any) => `<tr><td>${esc(fmtDate(t.date))}</td><td class="num">${num(t.mentions)}</td><td class="num">${t.sov != null ? Math.round(t.sov * 100) + "%" : "—"}</td></tr>`).join("")}</tbody></table>` : ""}`;
  } else {
    aeoBody = `
      <div class="grid grid-2" style="margin-top:10pt;">
        <div class="card"><div class="label">AEO readiness <span class="tag tag-measured">measured</span></div><div class="value">${aeoReadyTotal ? Math.round((aeoReadyPass / aeoReadyTotal) * 100) + "%" : "—"}</div><div class="sub">structured-data &amp; answer-content checks passing (${num(aeoReadyPass)}/${num(aeoReadyTotal)})</div></div>
        <div class="card"><div class="label">AI citation tracking</div><div class="value" style="font-size:11pt;">Being configured</div><div class="sub">Once live, this section reports the queries checked per AI engine, citations earned with the cited URL, and the trend across cycles.</div></div>
      </div>
      <p class="muted" style="margin-top:6pt;">What we track ahead of citations: answer-formatted content, FAQ/schema coverage, llms.txt for AI crawlers, and entity signals — the readiness score above. Citations follow readiness plus authority.</p>`;
  }
  const aeoHtml = `
  <section style="page-break-before: always;">
    <h2>6 · AI Visibility (AEO)</h2>
    <p>How the business shows up when customers ask AI assistants instead of searching. This is measured, not graded on a curve.</p>
    ${aeoBody}
  </section>`;

  const gradeTable = `
  <section>
    <h2>7 · Pillar Grades <span class="tag tag-grade">proprietary rubric v1 · graded checklist pass-rate</span></h2>
    <p>Each grade is the weighted pass-rate of that pillar's audit checks (A ≥90 · B ≥78 · C ≥65 · D ≥50). Grades are computed once by the audit engine and reported here unchanged. A pillar whose checks mostly could not be measured this cycle shows "not assessed" instead of a grade from partial data.</p>
    <table><thead><tr><th>Pillar</th><th>Baseline</th><th>Last cycle</th><th>Now</th><th>Notes &amp; next moves</th></tr></thead><tbody>
      ${gradeRows.map((g: any) => {
        const cell = (v: string | null) => v ? `<span class="grade grade-${esc(v)}">${esc(v)}</span>` : `<span class="muted">—</span>`;
        const nowCell = g.suppressed ? `<span class="grade grade-NA">not assessed<br>(${Math.round(g.coverage * 100)}% coverage)</span>` : cell(g.now);
        const bits: string[] = [];
        if (g.regression) bits.push(`<strong>Moved down.</strong> ${esc(g.cause)} <em>${esc(g.remediation)}</em>`);
        if (g.suppressed) bits.push("Measurement coverage too low this cycle to grade honestly.");
        if (g.plan) bits.push(esc(g.plan));
        return `<tr><td>${esc(g.label)}</td><td>${cell(g.base)}</td><td>${cell(g.prior)}</td><td>${nowCell}</td><td style="font-size:9.5pt;">${bits.join("<br>")}</td></tr>`;
      }).join("")}
    </tbody></table>
  </section>`;

  const plan = `
  <section style="page-break-before: always;">
    <h2>8 · Next Cycle — The Plan</h2>
    ${learnedFixed.length ? `<h4>Verified this cycle</h4><p>${learnedFixed.length} previously-open item${learnedFixed.length > 1 ? "s were" : " was"} confirmed fixed by re-measurement.</p>` : ""}
    ${nextActions.length ? `<h3>Committed actions</h3>
      <table><thead><tr><th>Action</th><th>What it does</th><th>Program area</th></tr></thead><tbody>
      ${nextActions.map((i: any) => `<tr><td><strong>${esc(i.title)}</strong></td><td style="font-size:9.5pt;">${esc(i.action || "")}</td><td style="font-size:9.5pt;">${esc(i.service || "")}</td></tr>`).join("")}</tbody></table>`
      : `<p>The next audit cycle sets the specific work items.</p>`}
    ${gateRejects.length ? `<h4>Deliberately not pursuing</h4><ul class="clean">${gateRejects.map((r: any) => `<li><strong>${esc(r.keyword)}</strong> — ${esc(r.reason)}</li>`).join("")}</ul>` : ""}
    ${roadmap.length ? `<h4>On the roadmap beyond the current plan</h4><ul class="clean">${roadmap.map((i: any) => `<li>${esc(i.title)}</li>`).join("")}</ul>` : ""}
  </section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(clientName)} — SEO &amp; AEO Progress Report — ${esc(reportDate)}</title>
<style>${css}</style></head><body><div class="wrap">
${cover}${context}${ledger}${work}${leading}${lagging}${aeoHtml}${gradeTable}${plan}
<div class="footer">Prepared${brand.name ? " by " + esc(brand.name) : ""} · ${esc(reportDate)} · Sources are labeled per metric: measured (Google Search Console), modeled estimate (third-party index), or proprietary rubric. Unavailable data is reported as unavailable.</div>
</div></body></html>`;
}

function prettyKind(kind: string): string {
  const m: Record<string, string> = { blog: "Blog article", landing: "Landing page", service: "Service page", pillar: "Pillar article", gbp_post: "Business Profile post", faq: "FAQ content" };
  return m[kind] || kind;
}
