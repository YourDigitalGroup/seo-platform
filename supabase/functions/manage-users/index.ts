// ============================================================================
//  manage-users — the console's Team & Access panel backend.
// ----------------------------------------------------------------------------
//  Browser code can never hold the service-role key, so user administration
//  lives here: create users (auto-confirmed), reset passwords, set name/role,
//  remove users. Callable ONLY by a logged-in console user whose profiles.role
//  is 'admin' — the caller's JWT is verified server-side before any action.
//
//  Deploy: Edge Functions → manage-users.
//  Input:  { action: "list" }
//          { action: "create", email, password, name?, role? }
//          { action: "set_password", user_id, password }
//          { action: "update_profile", user_id, name?, role? }
//          { action: "delete", user_id }
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// profiles.role stores the DB values; accept the console's short aliases too.
const ROLE_ALIAS: Record<string, string> = {
  super_admin: "super_admin", admin: "super_admin",
  account_manager: "account_manager", am: "account_manager",
  strategist: "strategist",
};
const ADMIN_ROLES = ["super_admin", "admin"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // ── Caller must be a logged-in console ADMIN ─────────────────────────────
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await supa.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "sign in required" }, 401);
    const { data: prof } = await supa.from("profiles").select("role").eq("id", caller.user.id).maybeSingle();
    if (!ADMIN_ROLES.includes(String(prof?.role || ""))) {
      return json({ error: "admin role required — ask a Super Admin to change your role" }, 403);
    }

    const action = String(body.action || "");

    if (action === "list") {
      const { data, error } = await supa.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) return json({ error: error.message }, 400);
      const ids = data.users.map((u) => u.id);
      const { data: profs } = ids.length ? await supa.from("profiles").select("id, name, role").in("id", ids) : { data: [] as any[] };
      const byId: Record<string, any> = {}; (profs || []).forEach((p: any) => { byId[p.id] = p; });
      return json({ ok: true, users: data.users.map((u) => ({
        id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
        name: byId[u.id]?.name || "", role: byId[u.id]?.role || "",
      })).sort((a, b) => String(a.email).localeCompare(String(b.email))) });
    }

    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || "").trim() || email.split("@")[0];
      const role = ROLE_ALIAS[String(body.role)] || "strategist";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "valid email required" }, 400);
      if (password.length < 6) return json({ error: "password must be at least 6 characters" }, 400);
      const { data, error } = await supa.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
      const { error: pErr } = await supa.from("profiles").upsert({ id: data.user.id, name, email, role });
      if (pErr) return json({ ok: true, id: data.user.id, warning: `user created but profile failed: ${pErr.message}` });
      return json({ ok: true, id: data.user.id });
    }

    if (action === "set_password") {
      const password = String(body.password || "");
      if (!body.user_id) return json({ error: "user_id required" }, 400);
      if (password.length < 6) return json({ error: "password must be at least 6 characters" }, 400);
      const { error } = await supa.auth.admin.updateUserById(String(body.user_id), { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "update_profile") {
      if (!body.user_id) return json({ error: "user_id required" }, 400);
      const patch: Record<string, string> = {};
      if (body.name != null) patch.name = String(body.name).trim();
      if (body.role != null) {
        const norm = ROLE_ALIAS[String(body.role)];
        if (!norm) return json({ error: "role must be super_admin, account_manager, or strategist" }, 400);
        patch.role = norm;
      }
      // The last admin must never demote themselves into a lockout.
      if (patch.role && !ADMIN_ROLES.includes(patch.role) && String(body.user_id) === caller.user.id) {
        const { count } = await supa.from("profiles").select("id", { count: "exact", head: true }).in("role", ADMIN_ROLES);
        if ((count || 0) <= 1) return json({ error: "you are the only admin — assign another admin first" }, 400);
      }
      const uid = String(body.user_id);
      const { data: upd, error } = await supa.from("profiles").update(patch).eq("id", uid).select("id");
      if (error) return json({ error: error.message }, 400);
      if (!upd?.length) {
        // No profile row yet (user was created outside the console) — create one.
        const { data: au } = await supa.auth.admin.getUserById(uid);
        if (!au?.user) return json({ error: "no such user" }, 404);
        const email = au.user.email || "";
        const { error: uErr } = await supa.from("profiles").upsert({
          id: uid, email,
          name: patch.name || email.split("@")[0],
          role: patch.role || "strategist",
        });
        if (uErr) return json({ error: uErr.message }, 400);
      }
      return json({ ok: true });
    }

    if (action === "delete") {
      if (!body.user_id) return json({ error: "user_id required" }, 400);
      if (String(body.user_id) === caller.user.id) return json({ error: "you can't remove your own account" }, 400);
      const { error } = await supa.auth.admin.deleteUser(String(body.user_id));
      if (error) return json({ error: error.message }, 400);
      await supa.from("profiles").delete().eq("id", String(body.user_id));
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("manage-users fatal", e);
    return json({ error: "unhandled", detail: String((e as any)?.stack || e).slice(0, 500) }, 500);
  }
});
