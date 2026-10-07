import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {BRAND_HEAD,BRAND_LOGO} from '../src/brand.js';

const ORIGIN='https://assistant.example';
const PASSWORD='owner-password-that-is-long-enough';
const AUTH='Basic '+Buffer.from('admin:'+PASSWORD).toString('base64');
const PNG=[0x89,0x50,0x4e,0x47],RIFF=[0x52,0x49,0x46,0x46];
const head=async response=>[...new Uint8Array(await response.arrayBuffer()).slice(0,4)];

test('the S favicon and the logo are served as real images without any login',async()=>{
  for(const [path,type,magic] of [['/favicon.ico','image/png',PNG],['/favicon.png','image/png',PNG],
    ['/apple-touch-icon.png','image/png',PNG],['/brand/logo.webp','image/webp',RIFF]]){
    const response=await worker.fetch(new Request(ORIGIN+path),{});
    assert.equal(response.status,200,path);
    assert.equal(response.headers.get('content-type'),type,path);
    assert.match(response.headers.get('cache-control'),/max-age=\d+/);
    assert.deepEqual(await head(response),magic,path);
  }
  const probe=await worker.fetch(new Request(ORIGIN+'/favicon.png',{method:'HEAD'}),{});
  assert.equal(probe.status,200);
  assert.equal((await probe.arrayBuffer()).byteLength,0);
  // Only the four fixed paths exist, and only for reading.
  assert.notEqual((await worker.fetch(new Request(ORIGIN+'/brand/other.png'),{})).headers.get('content-type'),'image/png');
  assert.notEqual((await worker.fetch(new Request(ORIGIN+'/favicon.png',{method:'POST'}),{})).headers.get('content-type'),'image/png');
});

test('every page carries the favicon and the logo, and its policy allows them',async()=>{
  const env={SETUP_PASSWORD:PASSWORD,TELEGRAM_CUTOVER_ENABLED:'false'};
  const pages=[
    await worker.fetch(new Request(ORIGIN+'/app'),env),
    await worker.fetch(new Request(ORIGIN+'/admin/import/tasks',{headers:{authorization:AUTH}}),env),
    await worker.fetch(new Request(ORIGIN+'/admin/telegram/cutover',{headers:{authorization:AUTH}}),env)
  ];
  for(const page of pages){
    const html=await page.text();
    assert.match(html,/<link rel="icon" type="image\/png" href="\/favicon\.png">/);
    assert.match(html,/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
    assert.match(html,/<img[^>]+src="\/brand\/logo\.webp"[^>]+alt="Skoomaholic Dev"/);
    assert.match(page.headers.get('content-security-policy'),/img-src 'self'/);
  }
  assert.match(BRAND_HEAD,/favicon\.png/);
  assert.match(BRAND_LOGO,/width="180" height="135"/);
});
