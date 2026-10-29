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
//  AL refuses a bad field with a bare "Invalid Request". When the full
//  listing is refused, sync/order send the core NAP listing alone, then add
//  email / description / categories / hours back one at a time — the listing
//  still syncs and the refused fields come back as a warning to fix.
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
    const isScheduler = action === "status" && jwt.length > 0 && jwt === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const { data: caller } = isScheduler ? { data: { user: { id: "scheduler", email: "scheduler" } } } : await supa.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "sign in required" }, 401);
    const { data: prof } = isScheduler ? { data: { role: "service_role" } } : await supa.from("profiles").select("role").eq("id", caller.user.id).maybeSingle();
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
      if (!r.ok) {
        // Keep everything AL says beyond the headline (field-level details,
        // when it sends them) so a refusal is diagnosable from the toast.
        const head = (j && (typeof j.error === "string" ? j.error : j.message)) || "";
        const extra = j && typeof j === "object"
          ? JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k, v]) => v != null && v !== "" && !["status", "success"].includes(k) && !(k === "error" && v === head) && !(k === "message" && v === head))))
          : "";
        throw new Error(`Advice Local ${method} ${path} → HTTP ${r.status}: ${head || text.slice(0, 240)}${extra && extra !== "{}" ? " " + extra.slice(0, 300) : ""}`);
      }
      if (j && typeof j === "object" && "success" in j) {
        if (j.success !== true) throw new Error(`Advice Local ${method} ${path}: ${JSON.stringify(j.error ?? j).slice(0, 240)}`);
        return j.data;
      }
      return j;
    };
    // Create (POST) or update (PUT) the AL location. AL answers a bad field
    // with a bare "Invalid Request" and no field name, so when the full
    // listing is refused: send the core NAP listing alone, then add each
    // optional field back one at a time — the listing still syncs, and the
    // refused fields are named for the specialist to fix.
    const CORE = ["name", "street", "city", "state", "zipcode", "country", "phone", "website"];
    const OPTIONAL = ["email", "description", "services", "hours"];
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => payload[k]).map((k) => [k, payload[k]]));
    const refused = (e: unknown) => /HTTP 4(00|22)|Invalid Request/i.test(String((e as any)?.message || e));
    const msg = (e: unknown) => String((e as any)?.message || e).replace(/^Advice Local \w+ \S+ → /, "");
    const upsertLocation = async (existing: number | null): Promise<{ id: number; rejected: string[]; created: unknown }> => {
      const send = (id: number | null, data: Record<string, string>) =>
        id ? al("PUT", `/legacyclients/${id}`, data) : al("POST", "/legacyclients", data);
      try {
        const r = await send(existing, payload);
        return { id: existing ?? Number(r?.id), rejected: [], created: r };
      } catch (e) {
        if (!refused(e)) throw e;
        console.warn(`advice-local: full listing refused for ${client.url} (${msg(e)}) — isolating fields`);
        const core = pick(CORE);
        let r: any;
        try { r = await send(existing, core); }
        catch (e2) {
          throw new Error(`Advice Local refused the core listing (${msg(e2)}). Check the name, street, city, state, ZIP, phone and website in Business Facts — sent: ${JSON.stringify(core).slice(0, 300)}`);
        }
        const id = existing ?? Number(r?.id);
        if (!id) return { id: 0, rejected: [], created: r };
        const kept: Record<string, string> = { ...core };
        const rejected: string[] = [];
        for (const k of OPTIONAL) {
          if (!payload[k]) continue;
          try { await al("PUT", `/legacyclients/${id}`, { ...kept, [k]: payload[k] }); kept[k] = payload[k]; }
          // never throw here: the location exists now, and its id must be saved
          catch (e3) { console.warn(`advice-local: ${k} refused (${msg(e3)})`); rejected.push(k); }
        }
        console.warn(`advice-local: ${client.url} synced as #${id} without: ${rejected.join(", ") || "(none)"}`);
        return { id, rejected, created: r };
      }
    };
    const FIELD_LABEL: Record<string, string> = { email: "email", description: "business description", services: "categories", hours: "hours" };
    const rejectedNote = (rej: string[]) => rej.length
      ? `Advice Local refused the ${rej.map((k) => FIELD_LABEL[k] || k).join(", ")} — the listing synced without ${rej.length > 1 ? "them" : "it"}; adjust ${rej.length > 1 ? "those" : "that"} in Business Facts and Sync again`
      : null;

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
      const existing = client.al_client_id ? Number(client.al_client_id) : null;
      const up = await upsertLocation(existing);
      if (!up.id) return json({ error: "Advice Local did not return a location id", response: up.created }, 502);
      const warn = await remember({ al_client_id: up.id, al_synced_at: new Date().toISOString() });
      return json({ ok: true, mode: existing ? "updated" : "created", al_client_id: up.id, payload, rejected: up.rejected,
        warning: [rejectedNote(up.rejected), warn].filter(Boolean).join(" · ") || null });
    }

    if (action === "status") {
      if (!client.al_client_id) return json({ error: "not linked to Advice Local yet — run Sync first" }, 400);
      const where = encodeURIComponent(JSON.stringify({ client: Number(client.al_client_id) }));
      const [products, fulfillment] = await Promise.all([
        al("GET", `/legacyorderproducts?where=${where}&limit=50`),
        al("GET", `/legacyfulfillmentdatas?where=${where}&limit=200&sort=dateUpdated%20DESC`),
      ]);
      const dirs = (Array.isArray(fulfillment) ? fulfillment : []).map((f: any) => ({
        directory: String(f.directory || "").trim(), status: String(f.status || ""), initial: String(f.statusInitial || ""),
        type: f.type, url: f.url || null, updated: f.dateUpdated || f.dateCreated || null,
      })).filter((f: any) => f.directory);
      const classify = (v: string) => {
        const t=v.toLowerCase().replace(/_/g," ");
        if (/temporar|retry/.test(t)) return {key:"retry",rank:3};
        if (/verif|confirm|postcard|action required|manual/.test(t)) return {key:"verify",rank:4};
        if (/reject|fail|error|denied|unavailable|not available|duplicate|closed|removed/.test(t)) return {key:"attn",rank:1};
        if (/added|claimed|updated|live|listed|complete|synced/.test(t)) return {key:"live",rank:5};
        if (/initial|pending|queue|submitted|processing|progress|scheduled/.test(t)) return {key:"queued",rank:2};
        return {key:"other",rank:0};
      };
      const dedup=new Map<string,any>();
      for(const f of dirs) {
        const key=f.directory.toLowerCase(),g=classify(f.status),old=dedup.get(key);
        if(!old){dedup.set(key,{...f,group:g.key,rank:g.rank});continue;}
        if(g.rank>old.rank){old.status=f.status;old.initial=f.initial;old.group=g.key;old.rank=g.rank;}
        if(!old.url&&f.url)old.url=f.url;
        if(String(f.updated||"")>String(old.updated||""))old.updated=f.updated;
      }
      const now=new Date().toISOString();
      const records=[...dedup.values()].map((f:any)=>({
        client_id:client.id,directory:f.directory,status:f.status,status_group:f.group,
        initial_status:f.initial,listing_url:f.url,updated_at_source:f.updated||null,fetched_at:now,
      }));
      // Atomic replacement is handled by the SQL function so an insert failure
      // cannot erase the previous good reporting snapshot.
      const { error: persistError } = await supa.rpc("replace_advice_local_directories",{
        p_client_id:client.id,p_records:records,
      });
      if(persistError) return json({ error:"Advice Local statuses retrieved but could not save reporting data",detail:persistError.message },500);
      return json({ok:true,al_client_id:client.al_client_id,al_order_id:client.al_order_id||null,
        products:(Array.isArray(products)?products:[]).map((p:any)=>({
          order:p.order,product:p.product,price:p.price,interval:p.intervalMaintenance,
          disabled:p.isDisabled===true||p.isDisabled==="true"
        })),directories:dirs,reporting_saved:true,reporting_directories:records.length});
    }

    if (action === "order") {
      const test = body.test === true;
      if (missing.length) return json({ error: "business facts incomplete — missing: " + missing.join(", ") }, 400);
      let alId = client.al_client_id ? Number(client.al_client_id) : null;
      let rejected: string[] = [];
      if (!alId) {   // first-time flow: create the location, then order
        const up = await upsertLocation(null);
        if (!up.id) return json({ error: "Advice Local did not return a location id", response: up.created }, 502);
        alId = up.id; rejected = up.rejected;
        await remember({ al_client_id: alId, al_synced_at: new Date().toISOString() });
      }
      if (!test && client.al_order_id) {
        return json({ error: `an LLO order (#${client.al_order_id}) is already on file for this client — check Fulfillment status instead of ordering twice` }, 400);
      }
      const res = await al("POST", "/legacyorders", { client: alId, products: [PRODUCT_ID], ...(test ? { test: true } : {}) });
      const orderId = res?.order?.id ? Number(res.order.id) : null;
      let warn: string | null = null;
      if (!test && orderId) warn = await remember({ al_order_id: orderId });
      warn = [rejectedNote(rejected), warn].filter(Boolean).join(" · ") || null;
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
