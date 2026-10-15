import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as rawRequest } from 'node:http';
import type { Asset, Bootstrap } from '../src/shared/types.js';
import { startServer, type RunningServer } from '../src/server/http.js';

class BrowserCookieJar {
  private cookies = new Map<string, { hostname: string; path: string; name: string; value: string }>();

  store(url: string, response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';').map((part) => part.trim());
      const separator = pair.indexOf('='), name = pair.slice(0, separator), value = pair.slice(separator + 1);
      const hostname = new URL(url).hostname;
      const path = attributes.find((attribute) => attribute.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      this.cookies.set(`${hostname};${path};${name}`, { hostname, path, name, value });
    }
  }

  header(url: string) {
    const target = new URL(url);
    return [...this.cookies.values()]
      .filter((cookie) => cookie.hostname === target.hostname && (target.pathname === cookie.path || target.pathname.startsWith(`${cookie.path}/`)))
      .map(({ name, value }) => `${name}=${value}`).join('; ');
  }

  get size() { return this.cookies.size; }
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-cookie-isolation-'));
  let running: RunningServer | undefined;
  t.after(async () => { await running?.close(); await rm(root, { recursive: true, force: true }); });
  running = await startServer({ root, port: 0 });
  return {
    get running() { return running!; },
    async restart() {
      const port = Number(new URL(running!.url).port);
      await running!.close();
      running = await startServer({ root, port });
    }
  };
}

async function bootstrap(running: RunningServer, jar: BrowserCookieJar) {
  const response = await fetch(`${running.url}/api/bootstrap`);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie')!;
  jar.store(running.url, response);
  return { value: await response.json() as Bootstrap, setCookie, cookie: setCookie.split(';')[0] };
}

async function upload(running: RunningServer, token: string, body: string) {
  const response = await fetch(`${running.url}/api/assets?name=sample.mp4&mime=video/mp4`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  assert.equal(response.status, 201);
  return await response.json() as Asset;
}

async function nativeReads(running: RunningServer, asset: Asset, jar: BrowserCookieJar) {
  const assetUrl = `${running.url}/api/assets/${asset.id}/content`;
  const assetResponse = await fetch(assetUrl, { headers: { Cookie: jar.header(assetUrl), Range: 'bytes=2-5' } });
  const eventsUrl = `${running.url}/api/events`;
  const eventsResponse = await fetch(eventsUrl, { headers: { Cookie: jar.header(eventsUrl) }, signal: AbortSignal.timeout(3000) });
  let event: string;
  if (eventsResponse.status === 200) {
    const reader = eventsResponse.body!.getReader();
    try { event = new TextDecoder().decode((await reader.read()).value); }
    finally { await reader.cancel(); }
  } else event = await eventsResponse.text();
  return { assetStatus: assetResponse.status, assetBytes: await assetResponse.text(), eventsStatus: eventsResponse.status, event };
}

test('two project ports keep native media and SSE authentication in one browser cookie jar', async (t) => {
  const a = await fixture(t), b = await fixture(t), jar = new BrowserCookieJar();
  const authA = await bootstrap(a.running, jar), assetA = await upload(a.running, authA.value.token, 'aaFIRSTaaa');
  const authB = await bootstrap(b.running, jar), assetB = await upload(b.running, authB.value.token, 'bbSECONDbb');
  const observations = await Promise.all([nativeReads(a.running, assetA, jar), nativeReads(b.running, assetB, jar)]);
  assert.deepEqual(observations, [
    { assetStatus: 206, assetBytes: 'FIRS', eventsStatus: 200, event: 'event: ready\ndata: {}\n\n' },
    { assetStatus: 206, assetBytes: 'SECO', eventsStatus: 200, event: 'event: ready\ndata: {}\n\n' }
  ]);
  for (const [running, auth] of [[a.running, authA], [b.running, authB]] as const) {
    assert.equal(auth.cookie.split('=')[0], `acanvas_auth_${new URL(running.url).port}`);
    assert.match(auth.setCookie, /; HttpOnly; SameSite=Strict; Path=\/api$/);
    const response = await fetch(`${running.url}/api/sessions`, { headers: { Authorization: `Bearer ${auth.value.token}` } });
    assert.equal(response.status, 200); await response.json();
  }
  assert.equal(jar.size, 2);
});

test('port-scoped cookies retain token, source, host and read-only authentication boundaries', async (t) => {
  const a = await fixture(t), b = await fixture(t), jar = new BrowserCookieJar();
  const authA = await bootstrap(a.running, jar), authB = await bootstrap(b.running, jar);
  const asset = await upload(a.running, authA.value.token, '0123456789');
  const paths = [`/api/assets/${asset.id}/content`, '/api/events'];
  const cookieName = authA.cookie.split('=')[0];
  for (const path of paths) {
    for (const cookie of [`${cookieName}=${authB.value.token}`, `acanvas_auth=${authA.value.token}`, authB.cookie]) {
      const response = await fetch(`${a.running.url}${path}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 401); await response.json();
    }
    for (const origin of [b.running.url, 'https://example.com', 'null']) {
      const response = await fetch(`${a.running.url}${path}`, { headers: { Cookie: jar.header(`${a.running.url}${path}`), Origin: origin } });
      assert.equal(response.status, 403); await response.json();
    }
    const crossSite = await fetch(`${a.running.url}${path}`, { headers: { Cookie: authA.cookie, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403); await crossSite.json();
  }
  const cookieWrite = await fetch(`${a.running.url}/api/sessions`, { method: 'POST', headers: { Cookie: jar.header(`${a.running.url}/api/sessions`), 'Content-Type': 'application/json' }, body: '{"name":"Cookie write"}' });
  assert.equal(cookieWrite.status, 401); await cookieWrite.json();
  const bearerWrite = await fetch(`${a.running.url}/api/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${authA.value.token}`, 'Content-Type': 'application/json' }, body: '{"name":"Bearer write"}' });
  assert.equal(bearerWrite.status, 201); await bearerWrite.json();
  const hostileHost = await new Promise<{ status: number; setCookie?: string[] }>((resolvePromise, reject) => {
    const request = rawRequest(`${a.running.url}/api/bootstrap`, { headers: { Host: `127.0.0.1:${new URL(b.running.url).port}` } }, (response) => {
      response.resume(); response.on('end', () => resolvePromise({ status: response.statusCode!, setCookie: response.headers['set-cookie'] }));
    });
    request.on('error', reject); request.end();
  });
  assert.deepEqual(hostileHost, { status: 403, setCookie: undefined });
  const rejectedBootstrap = await fetch(`${a.running.url}/api/bootstrap`, { headers: { Origin: b.running.url } });
  assert.equal(rejectedBootstrap.status, 403); assert.equal(rejectedBootstrap.headers.get('set-cookie'), null); await rejectedBootstrap.json();
});

test('a same-port restart renews its native cookie while another project remains readable', async (t) => {
  const a = await fixture(t), b = await fixture(t), jar = new BrowserCookieJar();
  const authA = await bootstrap(a.running, jar), assetA = await upload(a.running, authA.value.token, 'aaFIRSTaaa');
  const authB = await bootstrap(b.running, jar), assetB = await upload(b.running, authB.value.token, 'bbSECONDbb');
  const initialUrl = a.running.url;
  await a.restart();
  assert.equal(a.running.url, initialUrl);
  const staleCredentials: HeadersInit[] = [{ Cookie: authA.cookie }, { Authorization: `Bearer ${authA.value.token}` }];
  for (const headers of staleCredentials) {
    const response = await fetch(`${a.running.url}/api/assets/${assetA.id}/content`, { headers });
    assert.equal(response.status, 401); await response.json();
  }
  assert.deepEqual(await nativeReads(b.running, assetB, jar), { assetStatus: 206, assetBytes: 'SECO', eventsStatus: 200, event: 'event: ready\ndata: {}\n\n' });
  const renewed = await bootstrap(a.running, jar);
  assert.equal(renewed.cookie.split('=')[0], authA.cookie.split('=')[0]);
  assert.notEqual(renewed.value.token, authA.value.token);
  assert.equal(renewed.value.project.id, authA.value.project.id);
  assert.notEqual(renewed.value.service.instanceId, authA.value.service.instanceId);
  assert.equal(jar.size, 2);
  assert.equal(jar.header(`${b.running.url}/api/events`).split('; ').find((cookie) => cookie.startsWith(`${authB.cookie.split('=')[0]}=`)), authB.cookie);
  assert.deepEqual(await Promise.all([nativeReads(a.running, assetA, jar), nativeReads(b.running, assetB, jar)]), [
    { assetStatus: 206, assetBytes: 'FIRS', eventsStatus: 200, event: 'event: ready\ndata: {}\n\n' },
    { assetStatus: 206, assetBytes: 'SECO', eventsStatus: 200, event: 'event: ready\ndata: {}\n\n' }
  ]);
});
