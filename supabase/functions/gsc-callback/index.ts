// ============================================================================
//  gsc-callback — Google redirects here after "Connect Google" (gsc-oauth).
//  Stores the refresh token in Vault (GSC_REFRESH_<CONNECTION>) and records
//  the granted scopes: full Search Console + Site Verification lets
//  gsc-manage create/verify properties and submit sitemaps; read-only keeps
//  the data pull working. Deploy with verify_jwt OFF (Google can't send one).
// ============================================================================
import {createClient} from "npm:@supabase/supabase-js@2";
const base=()=>Deno.env.get("SUPABASE_URL")!;
const admin=()=>createClient(base(),Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const response=(msg:string,status=200)=>new Response(msg,{status,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
async function key(name:string){
 const {data,error}=await admin().rpc("platform_key",{p_name:name});
 return !error&&typeof data==="string"&&data ? data : Deno.env.get(name)||"";
}
Deno.serve(async req=>{
 const u=new URL(req.url);
 if(req.method!=="GET")return response("GET only",405);
 const state=u.searchParams.get("state")||"";
 if(!/^[a-f0-9]{64}$/.test(state))return response("Invalid Google sign-in state.",400);
 const supa=admin();
 const {data:st,error:stateErr}=await supa.from("gsc_oauth_states").delete().eq("state",state)
  .select("connection,created_by,created_at").maybeSingle();
 if(stateErr||!st||Date.now()-new Date(st.created_at).getTime()>1800000)return response("Google sign-in expired. Restart from Team & access.",400);
 const googleError=u.searchParams.get("error");
 if(googleError)return response("Connection was not completed: "+googleError,400);
 const code=u.searchParams.get("code")||"";
 if(!code)return response("Authorization code missing.",400);
 try{
   const [id,secret]=await Promise.all([key("GSC_OAUTH_CLIENT_ID"),key("GSC_OAUTH_CLIENT_SECRET")]);
   if(!id||!secret)throw Error("Missing OAuth client configuration");
   const tokenRes=await fetch("https://oauth2.googleapis.com/token",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"authorization_code",code,client_id:id,client_secret:secret,redirect_uri:base()+"/functions/v1/gsc-callback"}),
      signal:AbortSignal.timeout(20000)
   });
   const tok=await tokenRes.json().catch(()=>({}));
   if(!tokenRes.ok)throw Error("Google token exchange failed: "+String(tok.error_description||tok.error||tokenRes.status));
   const scope=String(tok.scope||"");
   const full=/auth\/webmasters(\s|$)/.test(scope), readOnly=/webmasters\.readonly/.test(scope), verifyOk=/siteverification/.test(scope);
   if(!full&&!readOnly)throw Error("Google Search Console permission was not granted.");
   if(!tok.refresh_token)throw Error("Google did not provide offline access. Remove the existing grant and reconnect.");
   const userRes=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{
     headers:{"Authorization":"Bearer "+tok.access_token},signal:AbortSignal.timeout(15000)
   });
   const info=await userRes.json().catch(()=>({}));
   if(!userRes.ok||!info.email||info.email_verified!==true)throw Error("Could not verify Google account email.");
   const {data:conn}=await supa.from("gsc_oauth_connections").select("expected_email").eq("connection",st.connection).single();
   const expected=String(conn?.expected_email||"").toLowerCase();
   const actual=String(info.email).toLowerCase();
   if(actual!==expected)throw Error("Wrong Google account: expected "+expected+" but received "+actual+". Retry using the expected account.");
   // verify the new token can list sites before saving it
   const sitesRes=await fetch("https://www.googleapis.com/webmasters/v3/sites",{
     headers:{"Authorization":"Bearer "+tok.access_token},signal:AbortSignal.timeout(20000)
   });
   const sites=await sitesRes.json().catch(()=>({}));
   if(!sitesRes.ok)throw Error("Google Search Console site listing failed: "+(sites?.error?.message||sitesRes.status));
   const {error:saveErr}=await supa.rpc("platform_key_set",{
     p_name:"GSC_REFRESH_"+String(st.connection).toUpperCase(),p_value:tok.refresh_token
   });
   if(saveErr)throw Error("Could not securely store the token.");
   const count=Array.isArray(sites.siteEntry)?sites.siteEntry.length:0;
   const {error:updateErr}=await supa.from("gsc_oauth_connections").update({
     account_email:actual,connected_at:new Date().toISOString(),connected_by:st.created_by,
     last_checked_at:new Date().toISOString(),properties_count:count,last_error:null,granted_scope:scope
   }).eq("connection",st.connection);
   if(updateErr)console.error("gsc-connection metadata",updateErr.message);
   const manage=full&&verifyOk;
   return response("Google Search Console connected as "+actual+" ("+count+" properties visible)"+
     (manage?" with permission to create and verify properties and submit sitemaps."
       :". Read-only: property setup and sitemap submission were NOT approved - click Reconnect and tick every permission to enable them.")+
     " Close this tab and refresh Team & access in the SEO/AEO platform.");
 }catch(e){
   const message=String((e as Error)?.message||e).slice(0,330);
   await supa.from("gsc_oauth_connections").update({last_error:message}).eq("connection",st.connection);
   console.error("gsc-callback",message);
   return response("Google Search Console connection failed: "+message+"\nReturn to Team & access and try again.",400);
 }
});
