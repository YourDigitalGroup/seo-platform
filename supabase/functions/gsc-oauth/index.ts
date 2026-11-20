// ============================================================================
//  gsc-oauth — connect the Google accounts the platform uses for Search
//  Console (Team & access → Search Console). Super admins only.
//    { action:"status" }                     connections + data quality
//    { action:"connect", connection }        Google sign-in URL (gsc-callback)
//  v3: asks for full Search Console + Site Verification access, so the
//  platform can create and verify properties and submit sitemaps
//  (gsc-manage). A connection made before v3 is read-only until reconnected.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
const BASE=()=>Deno.env.get("SUPABASE_URL")!;
const admin=()=>createClient(BASE(),Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...CORS,"Content-Type":"application/json"}});
export const GSC_SCOPES="openid email https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification";
const canManage=(scope:string|null|undefined)=>/auth\/webmasters(\s|$)/.test(String(scope||""))&&/siteverification/.test(String(scope||""));
async function key(name:string):Promise<string>{
  const {data,error}=await admin().rpc("platform_key",{p_name:name});
  if(!error&&typeof data==="string"&&data) return data;
  return Deno.env.get(name)||"";
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 if(req.method!=="POST")return reply({error:"POST only"},405);
 try{
  const jwt=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  const supa=admin();
  const {data:who,error:authErr}=await supa.auth.getUser(jwt);
  if(authErr||!who.user)return reply({error:"Sign in as a super admin"},401);
  const {data:profile}=await supa.from("profiles").select("role").eq("id",who.user.id).maybeSingle();
  if(profile?.role!=="super_admin")return reply({error:"Super admin required"},403);
  const {action,connection}=await req.json().catch(()=>({}));
  const {data:accounts,error:accountsErr}=await supa.from("gsc_oauth_connections").select("*").order("connection");
  if(accountsErr)throw accountsErr;
  const clientId=await key("GSC_OAUTH_CLIENT_ID");
  const clientSecret=await key("GSC_OAUTH_CLIENT_SECRET");
  if(action==="status") {
    const connections=[];
    for(const row of accounts||[]){
      const connected=Boolean(await key("GSC_REFRESH_"+row.connection.toUpperCase()));
      connections.push({...row,connected,can_manage:connected&&canManage(row.granted_scope)});
    }
    const {data:quality,error:qualityError}=await supa.from("looker_gsc_quality_status")
      .select("client_id,client_name,client_url,partner_group,configured_account,gsc_connected,data_status,last_attempt_at,last_success_at,property_url,error_code,property_impressions,property_clicks")
      .order("client_name").limit(500);
    if(qualityError)throw qualityError;
    const counts:Record<string,number>={};
    for(const c of quality||[])counts[c.data_status]=(counts[c.data_status]||0)+1;
    return reply({ok:true,callback_url:BASE()+"/functions/v1/gsc-callback",
      oauth_client_set:!!clientId&&!!clientSecret,connections,
      data_quality:{counts,clients:quality||[]}});
  }
  if(action!=="connect")return reply({error:"Unknown action"},400);
  const row=(accounts||[]).find((a:any)=>a.connection===connection);
  if(!row)return reply({error:"Unknown GSC account"},400);
  if(!clientId||!clientSecret)return reply({error:"Configure GSC_OAUTH_CLIENT_ID and GSC_OAUTH_CLIENT_SECRET in Team & access first"},400);
  const state=crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","");
  await supa.from("gsc_oauth_states").delete().lt("created_at",new Date(Date.now()-3600000).toISOString());
  const {error:stateErr}=await supa.from("gsc_oauth_states").insert({state,connection,created_by:who.user.email});
  if(stateErr)throw stateErr;
  const u=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search=new URLSearchParams({
   client_id:clientId,
   redirect_uri:BASE()+"/functions/v1/gsc-callback",
   response_type:"code",scope:GSC_SCOPES,
   access_type:"offline",prompt:"consent select_account",state,login_hint:row.expected_email
  }).toString();
  return reply({ok:true,url:u.toString()});
 }catch(e){console.error("gsc-oauth",String(e));return reply({error:String((e as Error).message||e).slice(0,240)},500);}
});
