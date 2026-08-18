// ============================================================================
//  advice-local — LLO fulfillment through the Advice Local partner API.
// ----------------------------------------------------------------------------
//  Advice Local (api.advicelocal.com, docs: wiki.advicelocal.com) submits the
//  business to the citation/directory network. This function is the only
//  place that talks to them — the partner API key must never reach the
//  browser. The console's LLO panel drives it with four actions:
//
//    { action: "preview", client_id }        what would be sent + what's missing
//    { action: "sync",    client_id }        create/update the AL business location
//    { action: "order",   client_id, test? } activate the LLO product (BILLABLE
//                                            unless test:true — dry run)
//    { action: "status",  client_id }        order products + per-directory
//                                            fulfillment status
//
//  Secrets (Edge Functions → advice-local → Secrets):
//    ADVICE_LOCAL_API_KEY      partner API key (x-api-token header)
//    ADVICE_LOCAL_PRODUCT_ID   optional — defaults to 4114 (the LLO product)
//
//  The AL location id / order id are remembered on the clients row
//  (al_client_id, al_order_id, al_synced_at — advice_local.sql), so sync is
//  idempotent: first call creates, later calls update the same location.
//
//  Any signed-in staff member can preview/sync/check status; placing the
//  order is billable, so it's limited to Super Admins and Account Managers.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const AL_BASE = "https://api.advicelocal.com";
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
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const KEY = Deno.env.get("ADVICE_LOCAL_API_KEY");
    if (!KEY) return json({ error: "ADVICE_LOCAL_API_KEY is not set — add it under Edge Functions → advice-local → Secrets" }, 500);
    const PRODUCT_ID = Number(Deno.env.get("ADVICE_LOCAL_PRODUCT_ID") || 4114);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // ── Caller must be signed-in staff; ordering is billable → AM/admin only ─
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await supa.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "sign in required" }, 401);
    const { data: prof } = await supa.from("profiles").select("role").eq("id", caller.user.id).maybeSingle();
    if (!prof) return json({ error: "no staff profile for this account" }, 403);
    if (action === "order" && !["super_admin", "admin", "account_manager"].includes(String(prof.role))) {
      return json({ error: "placing an Advice Local order is billable — ask an Account Manager or Super Admin" }, 403);
    }

    if (!body.client_id) return json({ error: "client_id required" }, 400);
    const { data: client } = await supa.from("clients").select("*").eq("id", body.client_id).maybeSingle();
    if (!client) return json({ error: "no such client" }, 404);
    const iv = (client.intake || {}) as Record<string, string>;

    // Advice Local's business-location payload, built from the approved
    // business facts (the intake is the only source of truth for NAP).
    const website = client.url ? "https://" + String(client.url).replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
    const payload: Record<string, string> = {
      name: String(client.name || "").trim(),
      street: String(iv.street || "").trim(),
      city: String(iv.city || "").trim(),
      state: String(iv.state || "").trim(),
      zipcode: String(iv.zip || "").trim(),
      country: "US",
      phone: String(iv.phone || "").trim(),
      website,
      email: String(iv.email || "").trim(),
      description: String(iv.description || "").trim(),
      services: String(iv.categories || "").trim(),
      hours: String(iv.hours || "").trim(),
    };
    const REQUIRED = ["name", "street", "city", "state", "zipcode", "phone", "website"];
    const missing = REQUIRED.filter((k) => !payload[k]);

    // Defensive call against the Advice Local API. The live API wraps every
    // response in { status, success, error, data } (the wiki's examples show
    // the bare payload) — unwrap it, and treat success:false as a failure.
    const al = async (method: string, path: string, data?: unknown) => {
      const r = await fetch(`${AL_BASE}${path}`, {
        method,
        headers: { "x-api-token": KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await r.text();
      let j: any = null; try { j = JSON.parse(text); } catch (_) { /* non-JSON error page */ }
      if (!r.ok) throw new Error(`Advice Local ${method} ${path} → HTTP ${r.status}: ${(j && (typeof j.error === "string" ? j.error : j.message)) || text.slice(0, 240)}`);
      if (j && typeof j === "object" && "success" in j) {
        if (j.success !== true) throw new Error(`Advice Local ${method} ${path}: ${JSON.stringify(j.error ?? j).slice(0, 240)}`);
        return j.data;
      }
      return j;
    };
    // clients.al_* live behind advice_local.sql — persist best-effort and
    // surface a warning instead of failing the whole call if it's missing.
    const remember = async (patch: Record<string, unknown>): Promise<string | null> => {
      const { error } = await supa.from("clients").update(patch).eq("id", client.id);
      return error ? `AL succeeded but the id could not be saved (${error.message}) — run advice_local.sql` : null;
    };

    if (action === "preview") {
      return json({ ok: true, payload, missing, product_id: PRODUCT_ID,
        al_client_id: client.al_client_id || null, al_order_id: client.al_order_id || null,
        al_synced_at: client.al_synced_at || null });
    }

    if (action === "sync") {
      if (missing.length) return json({ error: "business facts incomplete — missing: " + missing.join(", ") + ". Fill them in the LLO panel and Approve & save first." }, 400);
      let alId = client.al_client_id ? Number(client.al_client_id) : null;
      let mode = "updated";
      if (alId) {
        await al("PUT", `/legacyclients/${alId}`, payload);
      } else {
        const created = await al("POST", "/legacyclients", payload);
        alId = Number(created?.id);
        if (!alId) return json({ error: "Advice Local did not return a location id", response: created }, 502);
        mode = "created";
      }
      const warn = await remember({ al_client_id: alId, al_synced_at: new Date().toISOString() });
      return json({ ok: true, mode, al_client_id: alId, payload, warning: warn });
    }

    if (action === "status") {
      if (!client.al_client_id) return json({ error: "not linked to Advice Local yet — run Sync first" }, 400);
      const where = encodeURIComponent(JSON.stringify({ client: Number(client.al_client_id) }));
      const [products, fulfillment] = await Promise.all([
        al("GET", `/legacyorderproducts?where=${where}&limit=50`),
        al("GET", `/legacyfulfillmentdatas?where=${where}&limit=200&sort=dateUpdated%20DESC`),
      ]);
      return json({ ok: true, al_client_id: client.al_client_id, al_order_id: client.al_order_id || null,
        products: (Array.isArray(products) ? products : []).map((p: any) => ({
          order: p.order, product: p.product, price: p.price, interval: p.intervalMaintenance, disabled: p.isDisabled === true || p.isDisabled === "true" })),
        directories: (Array.isArray(fulfillment) ? fulfillment : []).map((f: any) => ({
          directory: f.directory, status: f.status, initial: f.statusInitial, type: f.type, url: f.url || null, updated: f.dateUpdated || f.dateCreated })) });
    }

    if (action === "order") {
      const test = body.test === true;
      if (missing.length) return json({ error: "business facts incomplete — missing: " + missing.join(", ") }, 400);
      let alId = client.al_client_id ? Number(client.al_client_id) : null;
      if (!alId) {   // first-time flow: create the location, then order
        const created = await al("POST", "/legacyclients", payload);
        alId = Number(created?.id);
        if (!alId) return json({ error: "Advice Local did not return a location id", response: created }, 502);
        await remember({ al_client_id: alId, al_synced_at: new Date().toISOString() });
      }
      if (!test && client.al_order_id) {
        return json({ error: `an LLO order (#${client.al_order_id}) is already on file for this client — check Fulfillment status instead of ordering twice` }, 400);
      }
      const res = await al("POST", "/legacyorders", { client: alId, products: [PRODUCT_ID], ...(test ? { test: true } : {}) });
      const orderId = res?.order?.id ? Number(res.order.id) : null;
      let warn: string | null = null;
      if (!test && orderId) warn = await remember({ al_order_id: orderId });
      console.log(`advice-local order ${test ? "(TEST) " : ""}client=${client.url || client.name} al=${alId} order=${orderId} by ${caller.user.email}`);
      return json({ ok: true, test, al_client_id: alId, order_id: orderId,
        price: res?.order?.price ?? null, products: res?.order?.products || [PRODUCT_ID], warning: warn });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("advice-local fatal", e);
    return json({ error: String((e as any)?.message || e).slice(0, 500) }, 500);
  }
});
