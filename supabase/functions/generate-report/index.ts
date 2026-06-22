// ============================================================================
//  Reporting Engine — generate-report Edge Function
// ----------------------------------------------------------------------------
//  Produces the client-facing PROGRESS REPORT for one package.
//
//  Narrative arc, by design:
//      1) Where we started   — the baseline (first audit for this client, or
//                              prior cycle's snapshot)
//      2) What we fixed/     — only fixes that were marked "pushed" and only
//         executed             content drafts that were approved
//      3) The result         — current ranking + traffic vs. baseline, real
//                              deltas only (no fabricated gains)
//
//  Output: a single self-contained HTML document the team opens in a browser
//  and prints to PDF (browser native Save as PDF). Vendor-scrubbed.
//  44i Digital, Inc. is the agency brand throughout.
//
//  Deploy: Edge Functions → Deploy new function → name it exactly: generate-report
//  Input:  { "package_id": "<uuid>" }    (recommended)
//      or  { "client_id":  "<uuid>" }    (uses the latest package)
//  Returns: { ok: true, html, baseline: <date|null>, current: <date>, deltas }
//  Honest baseline rule: on the first run there is no "before" — the result
//  section says "Starting position recorded on <date>; improvements tracked
//  from here," NOT fake improvement numbers.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Tiny HTML escaper — we render plain text into the report and must not allow
// stray markup from titles or keywords to break the layout.
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: unknown, def = "—") => (n == null || (typeof n === "number" && !isFinite(n))) ? def : (typeof n === "number" ? n.toLocaleString() : String(n));
const pct = (n: number) => `${Math.round(n)}%`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "—";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const pkgIdInput: string | null = body.package_id ?? null;
    const clientIdInput: string | null = body.client_id ?? null;
    if (!pkgIdInput && !clientIdInput) return json({ error: "package_id or client_id required" }, 400);

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── 1. Resolve the package and its audit (the "current" snapshot). ──
    let pkg: any = null;
    if (pkgIdInput) {
      const { data } = await supa.from("packages").select("id, client_id, audit_id, cycle_month, status").eq("id", pkgIdInput).single();
      pkg = data;
    } else {
      const { data } = await supa.from("packages").select("id, client_id, audit_id, cycle_month, status").eq("client_id", clientIdInput!).order("cycle_month", { ascending: false }).limit(1).maybeSingle();
      pkg = data;
    }
    if (!pkg) return json({ error: "package not found" }, 404);

    const { data: client } = await supa.from("clients").select("id, url, market, tier, partner_group_id").eq("id", pkg.client_id).single();
    const { data: currentAudit } = await supa.from("audits").select("*").eq("id", pkg.audit_id).single();
    if (!client || !currentAudit) return json({ error: "client or audit not found" }, 404);

    // ── 2. Find a BASELINE — the earliest audit for this client BEFORE the
    //      current one. If none exists, we honestly report "first cycle".
    const { data: priorAudits } = await supa.from("audits").select("id, run_at, domain_rating, org_keywords, org_traffic, org_keywords_top3, grade_technical, grade_onpage, grade_schema, grade_aeo, grade_eeat, grade_local, raw").eq("client_id", client.id).neq("id", currentAudit.id).order("run_at", { ascending: true }).limit(50);
    const baseline = (priorAudits && priorAudits.length) ? priorAudits[0] : null; // earliest run = baseline
    const lastPrior = (priorAudits && priorAudits.length) ? priorAudits[priorAudits.length - 1] : null; // most recent prior = "last cycle"

    // ── 3. Load executed work — only fixes that were PUSHED and content that
    //      was APPROVED count as "what we executed". Suggested or ready items
    //      live in the package, not in this client deliverable.
    const { data: pushedFixes } = await supa.from("fixes").select("id, kind, target_page, before_text, after_text, schema_jsonld, status, updated_at, context").eq("audit_id", pkg.audit_id).eq("status", "pushed");
    const { data: approvedDrafts } = await supa.from("content_drafts").select("id, topic_id, kind, title, body, approved").eq("package_id", pkg.id).eq("approved", true);

    // ── 4. Per-keyword deltas (real before/after). Compare current keywords
    //      table against the baseline audit's keywords table.
    const { data: currentKws } = await supa.from("keywords").select("keyword, position, volume, traffic, is_opportunity").eq("audit_id", pkg.audit_id);
    let baselineKws: any[] = [];
    if (baseline) {
      const { data } = await supa.from("keywords").select("keyword, position, volume, traffic").eq("audit_id", baseline.id);
      baselineKws = data || [];
    }
    const baseMap = new Map<string, any>();
    baselineKws.forEach((k) => baseMap.set(String(k.keyword).toLowerCase(), k));
    const movements = (currentKws || []).map((k: any) => {
      const b = baseMap.get(String(k.keyword).toLowerCase());
      const before = b?.position ?? null;
      const after = k.position ?? null;
      const delta = (before != null && after != null) ? before - after : null; // + = improved (rank went down numerically)
      return { keyword: k.keyword, volume: k.volume, before, after, delta, trafficNow: k.traffic, trafficBefore: b?.traffic ?? null, newlyRanking: before == null && after != null };
    });
    // Sort for the report: biggest improvements first, then new rankings, then everything else.
    movements.sort((a, b) => {
      const ad = a.delta ?? -999, bd = b.delta ?? -999;
      if (a.newlyRanking && !b.newlyRanking) return -1;
      if (!a.newlyRanking && b.newlyRanking) return 1;
      return bd - ad;
    });

    const improvements = movements.filter((m) => (m.delta || 0) > 0);
    const newlyRanking = movements.filter((m) => m.newlyRanking);
    const topMovements = movements.slice(0, 20);

    // ── 5. Pillar grade movement (current vs baseline). ──
    const pillars = [
      { key: "grade_technical", label: "Technical" },
      { key: "grade_onpage", label: "On-Page" },
      { key: "grade_schema", label: "Schema" },
      { key: "grade_aeo", label: "AEO" },
      { key: "grade_eeat", label: "E-E-A-T" },
      { key: "grade_local", label: "Local" },
    ];

    // ── 6. Raw fields from the audit (trade area, opportunities, authority). ──
    const raw = currentAudit.raw || {};
    const tradeArea = raw.tradeArea || { primary: client.market || "", secondary: [] };
    const opportunities: any[] = raw.opportunities || [];
    const authority = raw.authority || {};
    const traffic = raw.traffic || {};
    const business = raw.business || {};

    // ── 7. Group executed fixes by kind for readable presentation. ──
    const fixGroupLabels: Record<string, string> = {
      title_tag: "Title Tags Rewritten", meta_description: "Meta Descriptions Rewritten", h1: "H1 Tags Fixed",
      heading: "Headings Improved", page_copy: "Page Copy Strengthened", image_alt: "Image Alt Text Added",
      faq_schema: "FAQ Schema Deployed", local_business_schema: "LocalBusiness Schema Deployed",
      org_schema: "Organization Schema Deployed", person_schema: "Author/Person Schema Deployed",
      breadcrumb_schema: "Breadcrumb Schema Deployed", aggregate_rating_schema: "Review Rating Schema Deployed",
      internal_link: "Internal Linking Improved", gbp_post: "Business Profile Posts Published",
      canonical: "Canonical Tags Set", schema_jsonld: "Structured Data Deployed",
    };
    const fixesByKind = new Map<string, any[]>();
    (pushedFixes || []).forEach((f: any) => { if (!fixesByKind.has(f.kind)) fixesByKind.set(f.kind, []); fixesByKind.get(f.kind)!.push(f); });

    // ── 8. Compose the HTML. Single document, embedded CSS, print-optimized.
    //      Brand: 44i Digital. Color: #4B9BD7. Typeface: Manrope (via system stack
    //      fallback so the PDF renders even offline).
    const reportDate = fmtDate(currentAudit.run_at || new Date().toISOString());
    const baselineDate = baseline ? fmtDate(baseline.run_at) : null;
    const cycleNumber = (priorAudits?.length || 0) + 1;
    const isFirstCycle = !baseline;

    const clientName = (client.url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const market = tradeArea.primary || client.market || "";

    const html = renderHTML({
      clientName, market, reportDate, baselineDate, cycleNumber, isFirstCycle,
      business, tradeArea, authority, traffic, opportunities,
      currentAudit, baseline, lastPrior, pillars,
      pushedFixes: pushedFixes || [], fixesByKind, fixGroupLabels,
      approvedDrafts: approvedDrafts || [],
      movements, improvements, newlyRanking, topMovements,
    });

    return json({ ok: true, html,
      baseline: baseline?.run_at || null,
      current: currentAudit.run_at,
      deltas: { improvements: improvements.length, newlyRanking: newlyRanking.length, executedFixes: (pushedFixes || []).length, publishedContent: (approvedDrafts || []).length },
    });
  } catch (e) {
    console.error("generate-report fatal", e);
    return json({ error: "unhandled", detail: String(e) }, 500);
  }
});

// ── HTML rendering ────────────────────────────────────────────────────────────
// All client-facing copy lives here. The arc is enforced by the section order:
// Cover → Where we started → What we fixed/executed → The result → Next cycle.
function renderHTML(d: any): string {
  const {
    clientName, market, reportDate, baselineDate, cycleNumber, isFirstCycle,
    business, tradeArea, authority, traffic, opportunities,
    currentAudit, baseline, lastPrior, pillars,
    pushedFixes, fixesByKind, fixGroupLabels, approvedDrafts,
    movements, improvements, newlyRanking, topMovements,
  } = d;

  const css = `
    @page { size: letter; margin: 0.6in 0.55in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: 'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
           color: #1b2330; line-height: 1.55; font-size: 11.5pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .wrap { max-width: 7.4in; margin: 0 auto; padding: 0; }
    h1, h2, h3, h4 { font-family: 'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1b2330; margin: 0 0 8pt 0; line-height: 1.25; }
    h1 { font-size: 30pt; font-weight: 800; letter-spacing: -0.02em; }
    h2 { font-size: 18pt; font-weight: 700; margin-top: 22pt; border-bottom: 2px solid #4B9BD7; padding-bottom: 6pt; }
    h3 { font-size: 13pt; font-weight: 700; margin-top: 14pt; color: #2a3548; }
    h4 { font-size: 11pt; font-weight: 700; color: #4B9BD7; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 12pt; }
    p { margin: 0 0 8pt 0; }
    .lead { font-size: 12.5pt; color: #2a3548; }
    .muted { color: #6b7686; font-size: 10pt; }
    .cover { page-break-after: always; padding: 1.6in 0 0 0; }
    .cover .brand { color: #4B9BD7; font-weight: 800; letter-spacing: 0.04em; font-size: 11pt; text-transform: uppercase; margin-bottom: 36pt; }
    .cover h1 { font-size: 38pt; margin-bottom: 6pt; }
    .cover .sub { font-size: 16pt; color: #2a3548; font-weight: 500; margin-bottom: 30pt; }
    .cover .meta { margin-top: 40pt; padding-top: 18pt; border-top: 1px solid #e3e7ee; color: #2a3548; }
    .cover .meta div { margin-bottom: 4pt; }
    .cover .meta strong { color: #1b2330; }
    section { page-break-inside: avoid; }
    .grid { display: grid; gap: 10pt; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: repeat(3, 1fr); }
    .grid-4 { grid-template-columns: repeat(4, 1fr); }
    .card { border: 1px solid #e3e7ee; border-radius: 6pt; padding: 10pt 12pt; background: #fff; }
    .card .label { font-size: 9pt; color: #6b7686; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 4pt; }
    .card .value { font-size: 18pt; font-weight: 800; color: #1b2330; line-height: 1.1; }
    .card .sub { font-size: 9.5pt; color: #6b7686; margin-top: 3pt; }
    .pill { display: inline-block; padding: 2pt 7pt; border-radius: 9pt; font-size: 9pt; font-weight: 700; }
    .pill-blue { background: #e8f1fb; color: #4B9BD7; }
    .pill-good { background: #e1f5e7; color: #1f7a3c; }
    .pill-warn { background: #fdf0d8; color: #8a5a00; }
    .pill-bad  { background: #fbe1e1; color: #a01818; }
    .pill-neutral { background: #eef0f4; color: #4a5468; }
    table { width: 100%; border-collapse: collapse; font-size: 10.5pt; margin-top: 6pt; }
    th, td { text-align: left; padding: 6pt 7pt; border-bottom: 1px solid #e3e7ee; vertical-align: top; }
    th { color: #6b7686; font-weight: 600; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.04em; background: #f7f9fc; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .delta-up { color: #1f7a3c; font-weight: 700; }
    .delta-down { color: #a01818; font-weight: 700; }
    .delta-flat { color: #6b7686; }
    .grade { display: inline-block; min-width: 28pt; padding: 4pt 8pt; border-radius: 5pt; font-weight: 800; text-align: center; font-size: 12pt; }
    .grade-A { background: #1f7a3c; color: #fff; }
    .grade-B { background: #4B9BD7; color: #fff; }
    .grade-C { background: #d9a23a; color: #fff; }
    .grade-D { background: #c66a3a; color: #fff; }
    .grade-F { background: #a01818; color: #fff; }
    .callout { background: #f4f8fc; border-left: 4pt solid #4B9BD7; padding: 10pt 14pt; border-radius: 0 5pt 5pt 0; margin: 12pt 0; }
    .callout strong { color: #1b2330; }
    ul.clean { margin: 6pt 0 10pt 18pt; padding: 0; }
    ul.clean li { margin-bottom: 4pt; }
    .footer { margin-top: 32pt; padding-top: 12pt; border-top: 1px solid #e3e7ee; font-size: 9pt; color: #6b7686; text-align: center; }
    @media print { .no-print { display: none !important; } body { font-size: 11pt; } }
  `;

  // Cover
  const coverHtml = `
    <section class="cover">
      <div class="brand">44i Digital · SEO &amp; AEO Progress Report</div>
      <h1>${esc(clientName)}</h1>
      <div class="sub">${market ? esc(market) + " · " : ""}Cycle ${cycleNumber}${isFirstCycle ? " (Baseline)" : ""}</div>
      <div class="callout">${isFirstCycle
        ? `This is your <strong>baseline report</strong>. It records where the site stands today across the technical, on-page, schema, AEO, E-E-A-T, and local pillars, and lays out the trade-area opportunity. Every cycle after this will show real movement against this starting point — no fabricated gains, just measured progress.`
        : `This report shows what we executed this cycle and the measured results against your starting position from <strong>${esc(baselineDate)}</strong>. Every number is real and pulled directly from search data.`}
      </div>
      <div class="meta">
        <div><strong>Report date:</strong> ${esc(reportDate)}</div>
        ${baselineDate ? `<div><strong>Baseline established:</strong> ${esc(baselineDate)}</div>` : ""}
        ${business.type ? `<div><strong>Business:</strong> ${esc(business.type)}</div>` : ""}
        ${tradeArea?.primary ? `<div><strong>Primary trade area:</strong> ${esc(tradeArea.primary)}</div>` : ""}
        ${tradeArea?.secondary?.length ? `<div><strong>Secondary trade area:</strong> ${esc(tradeArea.secondary.join(", "))}</div>` : ""}
      </div>
    </section>
  `;

  // 1. Where we started — uses the current snapshot for first-cycle, the baseline for later cycles.
  const anchor = isFirstCycle ? currentAudit : baseline;
  const startedHtml = `
    <section>
      <h2>1 · Where ${isFirstCycle ? "We're Starting" : "We Started"}</h2>
      <p class="lead">${isFirstCycle
        ? `Here is the honest starting picture for ${esc(clientName)}. These numbers are the anchor every future improvement will be measured against.`
        : `On ${esc(baselineDate)}, your site looked like this. We use this as the fixed point of comparison for everything that follows.`}</p>

      <div class="grid grid-4" style="margin-top: 14pt;">
        <div class="card"><div class="label">Domain Authority</div><div class="value">${num(anchor.domain_rating)}</div><div class="sub">Authority signal vs the web</div></div>
        <div class="card"><div class="label">Ranking Keywords</div><div class="value">${num(anchor.org_keywords)}</div><div class="sub">${num(anchor.org_keywords_top3)} in the top 3</div></div>
        <div class="card"><div class="label">Monthly Organic Traffic</div><div class="value">${num(anchor.org_traffic)}</div><div class="sub">Visits from search</div></div>
        <div class="card"><div class="label">Referring Domains</div><div class="value">${num(anchor.referring_domains)}</div><div class="sub">Sites linking to yours</div></div>
      </div>

      ${(traffic.branded != null && traffic.nonBranded != null && (traffic.total || 0) > 0) ? `
        <h4>Traffic composition</h4>
        <p>Of your starting organic traffic, <strong>${pct((traffic.branded / Math.max(1, traffic.total)) * 100)}</strong> comes from people already searching your brand name and <strong>${pct((traffic.nonBranded / Math.max(1, traffic.total)) * 100)}</strong> from non-branded buyer-intent terms. Growing the non-branded share is how we acquire customers who don't yet know you.</p>
      ` : ""}

      ${opportunities.length ? `
        <h4>Trade-area opportunity</h4>
        <p>These are the highest-value local search terms in ${esc(tradeArea?.primary || market || "your area")} that you don't yet own or rank well for. This is where the strategy is aimed.</p>
        <table>
          <thead><tr><th>Search Term</th><th class="num">Monthly Searches</th><th class="num">Current Position</th><th>Status</th></tr></thead>
          <tbody>
            ${opportunities.slice(0, 10).map((o: any) => `
              <tr>
                <td>${esc(o.keyword)}</td>
                <td class="num">${num(o.volume)}</td>
                <td class="num">${o.position ? `#${o.position}` : "—"}</td>
                <td>${o.position ? `<span class="pill pill-warn">Ranking, needs lift</span>` : `<span class="pill pill-neutral">Not yet ranking</span>`}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : ""}

      ${(authority.medianCompetitor != null) ? `
        <h4>Authority vs your real local competitors</h4>
        <p>Your domain authority is <strong>${num(authority.client)}</strong>. The median authority across the businesses actually ranking for your trade-area terms is <strong>${num(authority.medianCompetitor)}</strong>. ${authority.client != null && authority.medianCompetitor > authority.client ? `That's the authority gap we need to close to outrank them on money terms.` : `You're at or above your local competition on authority — the bigger lever now is on-page targeting and content.`}</p>
      ` : ""}

      <h4>Where each area stood</h4>
      <div class="grid grid-3" style="margin-top: 6pt;">
        ${pillars.map((p: any) => {
          const g = (anchor as any)[p.key] || "F";
          return `<div class="card"><div class="label">${esc(p.label)}</div><div style="margin-top:4pt;"><span class="grade grade-${esc(g)}">${esc(g)}</span></div></div>`;
        }).join("")}
      </div>

      ${anchor.diagnosis ? `<div class="callout" style="margin-top: 14pt;"><strong>The starting diagnosis:</strong> ${esc(anchor.diagnosis)}</div>` : ""}
    </section>
  `;

  // 2. What we fixed / executed — only PUSHED fixes and APPROVED drafts.
  const executedAnything = pushedFixes.length > 0 || approvedDrafts.length > 0;
  const fixedHtml = `
    <section style="page-break-before: always;">
      <h2>2 · What We Fixed &amp; Executed</h2>
      ${!executedAnything ? `
        <p class="lead">${isFirstCycle
          ? `This is the baseline cycle — implementation work begins now. Your next progress report will list every change we deployed and tie it to the result it produced.`
          : `No deployable changes were marked completed in this reporting window. If work was completed in your CMS, mark the corresponding items as deployed inside the tool so the next report can credit it accurately.`}</p>
      ` : `
        <p class="lead">Every item below was actually deployed to your site during this cycle. We do not list work that was drafted but not pushed.</p>

        ${pushedFixes.length ? `
          <h3>Technical &amp; structural fixes</h3>
          <div class="grid grid-3" style="margin-top: 8pt;">
            ${[...fixesByKind.entries()].map(([kind, arr]: any) => `
              <div class="card"><div class="label">${esc(fixGroupLabels[kind] || kind)}</div><div class="value">${arr.length}</div><div class="sub">deployed</div></div>
            `).join("")}
          </div>
          <h4>What changed and why it matters</h4>
          <table>
            <thead><tr><th>Type</th><th>Where</th><th>What it accomplishes</th></tr></thead>
            <tbody>
              ${pushedFixes.slice(0, 30).map((f: any) => `
                <tr>
                  <td>${esc(fixGroupLabels[f.kind] || f.kind)}</td>
                  <td style="word-break:break-all;font-size:9.5pt;color:#4a5468;">${esc((f.target_page || "").replace(/^https?:\/\//, "").slice(0, 60))}</td>
                  <td>${esc(impactOfKind(f.kind))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : ""}

        ${approvedDrafts.length ? `
          <h3 style="margin-top:18pt;">New content published</h3>
          <p>New pages and articles built specifically to target your trade-area opportunity terms.</p>
          <table>
            <thead><tr><th>Title</th><th>Type</th></tr></thead>
            <tbody>
              ${approvedDrafts.slice(0, 20).map((c: any) => `
                <tr>
                  <td>${esc(c.title || "(untitled)")}</td>
                  <td>${esc(prettyKind(c.kind))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : ""}
      `}
    </section>
  `;

  // 3. The result — real before/after, or honest baseline notice on first cycle.
  let resultHtml = "";
  if (isFirstCycle) {
    resultHtml = `
      <section style="page-break-before: always;">
        <h2>3 · The Result</h2>
        <div class="callout">
          <strong>This is the baseline cycle.</strong> Starting position recorded on ${esc(reportDate)} — improvements will be tracked from here. We do not show fabricated gains.
        </div>
        <p>In your next progress report, this section will show:</p>
        <ul class="clean">
          <li><strong>Keyword ranking improvements</strong> — each priority term, where it ranked at baseline, where it ranks now, and the positions gained.</li>
          <li><strong>New keywords now ranking</strong> — every term that wasn't ranking at baseline and is now visible in search.</li>
          <li><strong>Traffic delta</strong> — measured monthly organic traffic change against baseline.</li>
          <li><strong>Pillar grade movement</strong> — how each of the six audit pillars improved.</li>
        </ul>
      </section>
    `;
  } else {
    const trafBefore = baseline?.org_traffic || 0;
    const trafNow = currentAudit?.org_traffic || 0;
    const trafDelta = trafNow - trafBefore;
    const trafPct = trafBefore ? Math.round((trafDelta / trafBefore) * 100) : null;
    const kwBefore = baseline?.org_keywords || 0;
    const kwNow = currentAudit?.org_keywords || 0;
    const kwDelta = kwNow - kwBefore;
    const drBefore = baseline?.domain_rating ?? null;
    const drNow = currentAudit?.domain_rating ?? null;

    resultHtml = `
      <section style="page-break-before: always;">
        <h2>3 · The Result</h2>
        <p class="lead">Measured movement from <strong>${esc(baselineDate)}</strong> through <strong>${esc(reportDate)}</strong>. All numbers come directly from search data, not estimates.</p>

        <div class="grid grid-4" style="margin-top: 14pt;">
          <div class="card"><div class="label">Ranking Keywords</div><div class="value">${num(kwNow)}</div><div class="sub">${formatDelta(kwDelta)} vs baseline</div></div>
          <div class="card"><div class="label">Monthly Organic Traffic</div><div class="value">${num(trafNow)}</div><div class="sub">${formatDelta(trafDelta)}${trafPct != null ? ` (${trafPct >= 0 ? "+" : ""}${trafPct}%)` : ""}</div></div>
          <div class="card"><div class="label">Domain Authority</div><div class="value">${num(drNow)}</div><div class="sub">${drBefore != null && drNow != null ? formatDelta(drNow - drBefore, true) : "—"}</div></div>
          <div class="card"><div class="label">Newly Ranking</div><div class="value">${num(newlyRanking.length)}</div><div class="sub">keywords not ranking at baseline</div></div>
        </div>

        ${improvements.length ? `
          <h3>Keyword position improvements</h3>
          <p>These are search terms where you moved up in Google's results — the closer to position 1, the more clicks the term earns.</p>
          <table>
            <thead><tr><th>Search Term</th><th class="num">Volume</th><th class="num">Before</th><th class="num">Now</th><th class="num">Positions Gained</th></tr></thead>
            <tbody>
              ${improvements.slice(0, 20).map((m: any) => `
                <tr>
                  <td>${esc(m.keyword)}</td>
                  <td class="num">${num(m.volume)}</td>
                  <td class="num">#${num(m.before)}</td>
                  <td class="num"><strong>#${num(m.after)}</strong></td>
                  <td class="num delta-up">+${num(m.delta)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : `<p class="muted">No improvements measured against baseline yet for this cycle.</p>`}

        ${newlyRanking.length ? `
          <h3>New keywords now ranking</h3>
          <p>These terms weren't ranking at all when we started. They are now.</p>
          <table>
            <thead><tr><th>Search Term</th><th class="num">Volume</th><th class="num">Current Position</th></tr></thead>
            <tbody>
              ${newlyRanking.slice(0, 15).map((m: any) => `
                <tr>
                  <td>${esc(m.keyword)}</td>
                  <td class="num">${num(m.volume)}</td>
                  <td class="num"><strong>#${num(m.after)}</strong></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : ""}

        <h3>Pillar grade movement</h3>
        <table>
          <thead><tr><th>Area</th><th>Before</th><th>Now</th></tr></thead>
          <tbody>
            ${pillars.map((p: any) => {
              const before = (baseline as any)[p.key] || "F";
              const now = (currentAudit as any)[p.key] || "F";
              return `<tr><td>${esc(p.label)}</td><td><span class="grade grade-${esc(before)}">${esc(before)}</span></td><td><span class="grade grade-${esc(now)}">${esc(now)}</span></td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>
    `;
  }

  // 4. Next cycle — opportunity terms still to win.
  const nextHtml = `
    <section style="page-break-before: always;">
      <h2>4 · Next Cycle</h2>
      <p class="lead">Where we're aiming the work next.</p>
      ${opportunities.length ? `
        <h3>Priority terms to target</h3>
        <p>These are the trade-area searches with the most upside that still aren't won. The next cycle's content and on-page work will be aimed at moving these.</p>
        <table>
          <thead><tr><th>Search Term</th><th class="num">Monthly Searches</th><th class="num">Current Position</th></tr></thead>
          <tbody>
            ${opportunities.slice(0, 10).map((o: any) => `
              <tr>
                <td>${esc(o.keyword)}</td>
                <td class="num">${num(o.volume)}</td>
                <td class="num">${o.position ? `#${o.position}` : "Not ranking"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<p>Specific targets will be set when the next audit cycle runs.</p>`}
    </section>
  `;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(clientName)} — SEO &amp; AEO Progress Report — ${esc(reportDate)}</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  ${coverHtml}
  ${startedHtml}
  ${fixedHtml}
  ${resultHtml}
  ${nextHtml}
  <div class="footer">Prepared by 44i Digital, Inc. · ${esc(reportDate)} · This report reflects measured data from search engines and your site only.</div>
</div>
</body>
</html>`;
}

function impactOfKind(kind: string): string {
  switch (kind) {
    case "title_tag": return "Search engines and AI assistants use this as the page's headline. A precise title increases click-through from results.";
    case "meta_description": return "Controls the preview text under your search result. Strong meta descriptions earn more clicks at the same ranking position.";
    case "h1": return "Tells search engines what the page is primarily about. A correct H1 anchors the keyword target.";
    case "heading": return "Structures content so search engines and AI can extract answers from your page.";
    case "page_copy": return "Strengthens the page's substance and keyword targeting so it competes for the term it should.";
    case "image_alt": return "Describes images for search engines and accessibility tools. Helps image search and screen-reader users.";
    case "faq_schema": return "Lets your page appear in 'People also ask' answers and AI assistant responses with direct quotes.";
    case "local_business_schema": return "Tells Google exactly what kind of business you are, where you're located, and how to contact you — required for strong local visibility.";
    case "org_schema": return "Establishes the business as a recognized entity to search engines and AI systems.";
    case "person_schema": return "Establishes authorship and expertise — key for E-E-A-T signals.";
    case "breadcrumb_schema": return "Gives Google a clean navigation trail to display in results.";
    case "aggregate_rating_schema": return "Surfaces star ratings under your search results, which materially increases click-through.";
    case "internal_link": return "Routes authority from strong pages to the pages you want to rank.";
    case "gbp_post": return "Keeps your Business Profile active — a documented local-pack ranking signal.";
    case "canonical": return "Prevents Google from splitting authority between near-duplicate URLs.";
    case "schema_jsonld": return "Adds the structured data search engines and AI use to understand your content.";
    default: return "Improves how search engines and AI understand and surface this page.";
  }
}

function prettyKind(kind: string): string {
  const m: Record<string, string> = { blog: "Blog article", landing: "Landing page", service: "Service page", pillar: "Pillar article", gbp_post: "Business Profile post", faq: "FAQ content" };
  return m[kind] || kind;
}

function formatDelta(n: number, isGrade = false): string {
  if (n === 0 || n == null) return `<span class="delta-flat">no change</span>`;
  const cls = n > 0 ? "delta-up" : "delta-down";
  const sign = n > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${num(n)}${isGrade ? " pts" : ""}</span>`;
}
