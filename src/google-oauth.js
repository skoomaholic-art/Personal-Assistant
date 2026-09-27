// Owner-only OAuth pairing. Strong Basic auth and one-time SameSite cookie.
// Google's refresh token is encrypted with AES-GCM before it enters D1.
// Pairing is disabled unless GOOGLE_OAUTH_SETUP_ENABLED=true.
import {hasValidSecret} from './router.js';
const SCOPES=['https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose'];
const COOKIE='__Host-rahal_oauth_state';
const h={'cache-control':'no-store','referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'"};
const b64=bytes=>{
  let str='';for(const c of bytes)str+=String.fromCharCode(c);
  return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const decode=str=>Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/')),
  c=>c.charCodeAt(0));
async function key(env) {
  if(!env.SETUP_PASSWORD||String(env.SETUP_PASSWORD).length<24||!env.GOOGLE_CLIENT_SECRET)
    throw Error('OAuth encryption secrets not configured');
  const material='rahal-oauth-aes-256-v1\0'+env.SETUP_PASSWORD+'\0'+env.GOOGLE_CLIENT_SECRET;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function encrypt(env,token) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},
    await key(env),new TextEncoder().encode(token));
  return 'v1.'+b64(iv)+'.'+b64(new Uint8Array(cipher));
}
export async function loadEncryptedGmailRefreshToken(env) {
  if(!env.DB)throw Error('D1 unavailable for OAuth');
  const row=await env.DB.prepare(
    "SELECT encrypted_refresh_token FROM oauth_credentials WHERE provider='gmail'"
  ).first();
  if(!row?.encrypted_refresh_token)throw Error('Gmail has not been connected');
  const [version,nonce,cipher]=row.encrypted_refresh_token.split('.');
  if(version!=='v1'||!nonce||!cipher)throw Error('OAuth token format invalid');
  try {
    const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(nonce)},
      await key(env),decode(cipher));
    const token=new TextDecoder('utf-8',{fatal:true}).decode(raw);
    if(!token||token.length>5000)throw Error('OAuth token invalid');
    return token;
  } catch {throw Error('Stored OAuth token cannot be decrypted');}
}
const clearCookie=COOKIE+'=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
const out=(body,status=200,extra={})=>new Response(body,{status,
  headers:{...h,'content-type':'text/plain; charset=utf-8',...extra}});
const redirect=(url,extra={})=>new Response(null,{status:302,
  headers:{...h,location:url,...extra}});
function redirectUri(request,env) {
  let url;
  try{url=new URL(String(env.GOOGLE_OAUTH_REDIRECT_URI||''));}
  catch{throw Error('OAuth redirect URI not configured');}
  if(url.protocol!=='https:'||url.pathname!=='/oauth/google/callback'||
     url.search||url.hash||url.origin!==new URL(request.url).origin)
    throw Error('OAuth redirect URI does not match this Worker');
  return url.href;
}
export function ownerAuthorized(request,env) {
  if(!env.SETUP_PASSWORD||env.SETUP_PASSWORD.length<24)return false;
  const auth=request.headers.get('authorization')||'';
  if(!auth.startsWith('Basic '))return false;
  try {
    const raw=atob(auth.slice(6)),sep=raw.indexOf(':');
    return sep>=0&&raw.slice(0,sep)==='admin'&&
      hasValidSecret(raw.slice(sep+1),String(env.SETUP_PASSWORD));
  } catch{return false;}
}
function cookieState(request) {
  const text=request.headers.get('cookie')||'';
  return text.match(/(?:^|;\s*)__Host-rahal_oauth_state=([a-zA-Z0-9_-]{20,100})(?:;|$)/)?.[1]||'';
}
function enabled(env) {
  return env.GOOGLE_OAUTH_SETUP_ENABLED==='true' &&
    Boolean(env.DB&&env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);
}
export async function startGoogleOAuth(request,env) {
  if(request.method!=='GET')return out('Method not allowed',405);
  if(!enabled(env))return out('Google pairing is disabled',503);
  if(!ownerAuthorized(request,env))
    return out('Owner authentication required',401,
      {'www-authenticate':'Basic realm="Персональный помощник", charset="UTF-8"'});
  try{
    await key(env);
    const state=b64(crypto.getRandomValues(new Uint8Array(32)));
    const args=new URLSearchParams({
      client_id:env.GOOGLE_CLIENT_ID,
      redirect_uri:redirectUri(request,env),
      response_type:'code',scope:SCOPES.join(' '),
      access_type:'offline',prompt:'consent',state
    });
    return redirect('https://accounts.google.com/o/oauth2/v2/auth?'+args.toString(),
      {'set-cookie':COOKIE+'='+state+'; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax'});
  }catch{return out('OAuth configuration incomplete',503);}
}
export async function completeGoogleOAuth(request,env) {
  if(request.method!=='GET')return out('Method not allowed',405,{'set-cookie':clearCookie});
  if(!enabled(env))return out('Pairing disabled',503,{'set-cookie':clearCookie});
  const url=new URL(request.url);
  const state=url.searchParams.get('state')||'',cookie=cookieState(request);
  if(url.searchParams.has('error'))return out('Google authorization cancelled',400,{'set-cookie':clearCookie});
  if(!state||!cookie||!hasValidSecret(state,cookie))
    return out('Expired or invalid browser state',400,{'set-cookie':clearCookie});
  const code=url.searchParams.get('code')||'';
  if(!code||code.length>2048)return out('Invalid Google authorization code',400,{'set-cookie':clearCookie});
  try{
    const body=new URLSearchParams({
      client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
      redirect_uri:redirectUri(request,env),grant_type:'authorization_code',code
    });
    const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body,signal:AbortSignal.timeout(10000)
    });
    if(!tokenResponse.ok)throw Error('Google OAuth exchange failed');
    const tokens=await tokenResponse.json();
    if(!tokens.access_token||!tokens.refresh_token)throw Error('Offline token was not provided');
    const granted=String(tokens.scope||'').split(/\s+/);
    if(!SCOPES.every(scope=>granted.includes(scope)))throw Error('Required scopes missing');
    const profile=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{
      headers:{authorization:'Bearer '+tokens.access_token},
      signal:AbortSignal.timeout(10000)
    });
    if(!profile.ok)throw Error('Could not verify connected Gmail account');
    const account=String((await profile.json()).emailAddress||'').toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account))throw Error('Invalid Gmail account');
    const expected=String(env.GMAIL_ALLOWED_ACCOUNT||'').trim().toLowerCase();
    if(expected&&account!==expected)throw Error('Wrong Google account selected');
    const encrypted=await encrypt(env,tokens.refresh_token);
    await env.DB.prepare(
      "INSERT INTO oauth_credentials(provider,encrypted_refresh_token,account_email,granted_scopes,updated_at) "+
      "VALUES('gmail',?,?,?,?) ON CONFLICT(provider) DO UPDATE SET "+
      "encrypted_refresh_token=excluded.encrypted_refresh_token,"+
      "account_email=excluded.account_email,granted_scopes=excluded.granted_scopes,"+
      "updated_at=excluded.updated_at"
    ).bind(encrypted,account,granted.join(' '),new Date().toISOString()).run();
    return out('Gmail connected: '+account+
      '. No messages imported or sent. Disable GOOGLE_OAUTH_SETUP_ENABLED after pairing.',
      200,{'set-cookie':clearCookie});
  }catch{
    // Never expose authorization codes, token values or Google error bodies.
    return out('Google pairing failed. Check OAuth permissions, account and D1 configuration. Nothing was sent.',
      503,{'set-cookie':clearCookie});
  }
}
