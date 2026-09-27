import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startGoogleOAuth,completeGoogleOAuth,loadEncryptedGmailRefreshToken
} from '../src/google-oauth.js';
const originalFetch=global.fetch;
test.afterEach(()=>{global.fetch=originalFetch;});
function context() {
  let saved=null;
  const DB={prepare:sql=>{
    let args=[];
    const st={
      bind:(...a)=>{args=a;return st;},
      first:async()=>{
        assert.match(sql,/oauth_credentials/);
        return saved;
      },
      run:async()=>{
        assert.match(sql,/INSERT INTO oauth_credentials/);
        saved={encrypted_refresh_token:args[0],account_email:args[1]};
        return {meta:{changes:1}};
      }
    };
    return st;
  }};
  const env={
    DB,GOOGLE_CLIENT_ID:'google-public-id',
    GOOGLE_CLIENT_SECRET:'private-test-client-secret',
    SETUP_PASSWORD:'a'.repeat(36)+'B!',
    GOOGLE_OAUTH_SETUP_ENABLED:'true',
    GOOGLE_OAUTH_REDIRECT_URI:'https://staging.example/oauth/google/callback',
    GMAIL_ALLOWED_ACCOUNT:'owner@my.example'
  };
  return {DB,env,saved:()=>saved};
}
const startUrl='https://staging.example/oauth/google/start';
test('Google pairing is disabled by default and cannot contact Google',async()=>{
  const c=context(),env={...c.env,GOOGLE_OAUTH_SETUP_ENABLED:'false'};
  global.fetch=()=>{throw Error('External network forbidden')};
  const response=await startGoogleOAuth(new Request(startUrl),env);
  assert.equal(response.status,503);
});
test('Google pairing requires a strong owner password, not a public link',async()=>{
  const {env}=context();
  const response=await startGoogleOAuth(new Request(startUrl),env);
  assert.equal(response.status,401);
  assert.match(response.headers.get('www-authenticate'),/Basic/);
});
test('OAuth code is exchanged only after correlated state; token is encrypted at rest',async()=>{
  const c=context();
  const auth='Basic '+Buffer.from('admin:'+c.env.SETUP_PASSWORD).toString('base64');
  const start=await startGoogleOAuth(new Request(startUrl,{
    headers:{authorization:auth}
  }),c.env);
  assert.equal(start.status,302);
  const url=new URL(start.headers.get('location'));
  assert.equal(url.origin,'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'),'offline');
  const state=url.searchParams.get('state');
  assert.ok(state?.length>20);
  assert.equal(url.searchParams.get('client_secret'),null);
  assert.equal(start.headers.get('set-cookie')?.includes('HttpOnly'),true);
  const cookie=start.headers.get('set-cookie').split(';')[0];
  let requests=0;
  global.fetch=async endpoint=>{
    requests++;
    if(String(endpoint).includes('oauth2.googleapis.com/token'))
      return Response.json({access_token:'fake-access-token',
        refresh_token:'private-refresh-token',
        scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose'});
    if(String(endpoint).includes('gmail/v1/users/me/profile'))
      return Response.json({emailAddress:'owner@my.example'});
    throw Error('Unexpected Google endpoint');
  };
  const bad=await completeGoogleOAuth(
    new Request('https://staging.example/oauth/google/callback?code=abc&state=WRONG',{
      headers:{cookie}
    }),c.env);
  assert.equal(bad.status,400);
  assert.equal(requests,0);
  const good=await completeGoogleOAuth(
    new Request('https://staging.example/oauth/google/callback?code=abc&state='+state,{
      headers:{cookie}
    }),c.env);
  assert.equal(good.status,200);
  assert.equal(requests,2);
  assert.ok(c.saved()?.encrypted_refresh_token.startsWith('v1.'));
  assert.equal(c.saved()?.encrypted_refresh_token.includes('private-refresh-token'),false);
  assert.equal(await loadEncryptedGmailRefreshToken(c.env),'private-refresh-token');
  assert.match(await good.text(),/successfully|connected/i);
});
test('OAuth callback rejects a different Google account without storing token',async()=>{
  const c=context();
  const auth='Basic '+Buffer.from('admin:'+c.env.SETUP_PASSWORD).toString('base64');
  const start=await startGoogleOAuth(new Request(startUrl,{
    headers:{authorization:auth}
  }),c.env);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const cookie=start.headers.get('set-cookie').split(';')[0];
  global.fetch=async url=>{
    if(String(url).includes('oauth2.googleapis.com/token'))
      return Response.json({access_token:'fake-access-token',refresh_token:'other-token',
        scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose'});
    return Response.json({emailAddress:'other@personal.example'});
  };
  const result=await completeGoogleOAuth(
    new Request('https://staging.example/oauth/google/callback?code=abc&state='+state,{
      headers:{cookie}
    }),c.env);
  assert.equal(result.status,503);
  assert.equal(c.saved(),null);
});
