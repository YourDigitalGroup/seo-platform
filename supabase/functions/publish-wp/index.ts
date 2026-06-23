// ============================================================================
//  publish-wp Edge Function
// ----------------------------------------------------------------------------
//  Pushes SEO-SAFE artifacts to a client's WordPress via the 44i SEO Platform
//  Connector plugin. Scope by design (matches "no visual changes"):
//    • content drafts        → created as a DRAFT post/page for human review
//    • title_tag / meta_description / canonical → SEO meta (invisible)
//    • *_schema / faq_schema → JSON-LD in <head> (invisible)
//  VISIBLE / TECHNICAL fixes (h1, heading, page_copy, internal_link, image_alt)
//  are intentionally REFUSED here and stay manual.
//
//  Input:  { "client_id": "<uuid>", "draft_id": "<uuid>" }   // push content
//      or  { "client_id": "<uuid>", "fix_id": "<uuid>" }     // push meta/schema
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const MANUAL_KINDS = new Set(["h1", "heading", "page_copy", "internal_link", "image_alt"]);
const SCHEMA_KINDS = new Set(["faq_schema", "local_business_schema", "org_schema", "person_schema", "breadcrumb_schema", "aggregate_rating_schema", "schema_jsonld"]);
// content kinds that map to a WordPress page vs a blog post
const PAGE_KINDS = new Set(["landing", "service", "pillar"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const client_id: string | undefined = body.client_id;
    if (!client_id) return json({ error: "client_id required" }, 400);

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: client, error: cErr } = await supa.from("clients")
      .select("id, url, wp_api_key, wp_connected").eq("id", client_id).single();
    if (cErr || !client) return json({ error: "client not found", detail: cErr?.message }, 404);
    if (!client.wp_api_key) return json({ error: "WordPress not connected — install the connector plugin on the site and save its API key on the client" }, 400);

    const host = String(client.url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const base = `https://${host}/wp-json/seo-platform/v1`;
    const call = async (path: string, payload: unknown) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "Authorization": `Bearer ${client.wp_api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const txt = await r.text();
      let j: any; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
      if (!r.ok) throw new Error(`WordPress ${r.status}: ${(j && (j.message || j.error)) || txt.slice(0, 200)}`);
      return j;
    };

    // ── Mode 1: push a written content draft (as a DRAFT post/page) ──
    if (body.draft_id) {
      const { data: d, error: dErr } = await supa.from("content_drafts")
        .select("id, title, body, content_topics(target_keyword, kind)").eq("id", body.draft_id).single();
      if (dErr || !d) return json({ error: "draft not found", detail: dErr?.message }, 404);
      const topic: any = Array.isArray(d.content_topics) ? d.content_topics[0] : d.content_topics;
      const kind = topic?.kind || "blog";
      if (kind === "gbp_post") return json({ error: "GBP posts publish to Google Business Profile, not WordPress", manual: true }, 422);
      const res = await call("/content", {
        title: d.title || "Untitled",
        content: d.body || "",
        status: "draft",                       // never auto-publish — human reviews in WP
        post_type: PAGE_KINDS.has(kind) ? "page" : "post",
        focus_keyword: topic?.target_keyword || "",
        external_id: d.id,
      });
      await supa.from("deliverables").update({ state: "delivered", asset_url: res.edit_url || null }).eq("draft_id", d.id);
      return json({ ok: true, kind: "content", wp: res });
    }

    // ── Mode 2: push a fix (SEO meta or schema only) ──
    if (body.fix_id) {
      const { data: f, error: fErr } = await supa.from("fixes")
        .select("id, kind, target_page, after_text, schema_jsonld").eq("id", body.fix_id).single();
      if (fErr || !f) return json({ error: "fix not found", detail: fErr?.message }, 404);
      if (MANUAL_KINDS.has(f.kind)) return json({ error: `${f.kind} changes visible page content — apply this one manually`, manual: true }, 422);
      const target = f.target_page || client.url;

      if (f.kind === "title_tag")        return json({ ok: true, kind: f.kind, wp: await call("/seo-meta", { target, seo_title: f.after_text || "" }) });
      if (f.kind === "meta_description") return json({ ok: true, kind: f.kind, wp: await call("/seo-meta", { target, seo_description: f.after_text || "" }) });
      if (f.kind === "canonical")        return json({ ok: true, kind: f.kind, wp: await call("/seo-meta", { target, canonical: f.after_text || "" }) });
      if (SCHEMA_KINDS.has(f.kind)) {
        const jsonld = f.schema_jsonld || f.after_text;
        if (!jsonld) return json({ error: "no JSON-LD on this fix" }, 400);
        return json({ ok: true, kind: f.kind, wp: await call("/schema", { target, jsonld }) });
      }
      return json({ error: `kind '${f.kind}' is not auto-deployable — apply manually`, manual: true }, 422);
    }

    return json({ error: "provide draft_id (content) or fix_id (meta/schema)" }, 400);
  } catch (e) {
    console.error("publish-wp", e);
    return json({ error: "publish failed", detail: String(e) }, 502);
  }
});
