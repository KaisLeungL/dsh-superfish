import test from 'node:test';
import assert from 'node:assert/strict';
import { healthRoutes, type HealthConnection, type HealthControl, type Peer, type HealthWebServer } from '../../src/app/health/http.js';
import { formatSoulPrompt, renderSoulMarkdownDocument } from '../../src/app/health/chat-input.js';
import { unavailableHealth } from '../../src/app/health/view.js';
import { CONTROL_TOKEN_HEADER } from '../../src/status.js';
import { deferred } from '../lifecycle/fixture.js';
function fixture() {
  const ownerAbort = new AbortController();
  const browser: Peer = { id: 'host-browser-owner', principal: { kind: 'owner' }, signal: ownerAbort.signal };
  const api: Peer = { id: 'distinct-api-owner', principal: { kind: 'owner' }, signal: new AbortController().signal };
  let revision = 1, calls = 0, origin = 'http://127.0.0.1:1234';
  let rejection: number | undefined;
  let server: HealthWebServer | undefined = { getOrigin: () => origin };
  let connection: HealthConnection = { browserPeer: browser, requestRejection: () => rejection, admit: request =>
    request.headers.get('x-test-credential') === 'browser' ? { peer: browser } :
    request.headers.get('x-test-credential') === 'api' ? { peer: api } : { rejection: 401 },
    fetch: { register: () => async () => {} } };
  const control: HealthControl = { read: () => unavailableHealth('component-only'),
    revision: () => revision, execute(_action, expected, _proof, caller) {
      caller.assertCurrent(); assert.equal(expected, revision); revision++; calls++;
    } };
  const routes = healthRoutes(() => connection, () => control, () => server);
  const request = (body: unknown = { action: 'pause', revision: 1 }, credential = 'browser', origin = 'http://127.0.0.1:1234') =>
    new Request('http://dsh.internal/api/workspace-superagent/control', { method: 'POST',
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-test-credential': credential }, body: JSON.stringify(body) });
  return { browser, api, ownerAbort, routes, request, control, calls: () => calls,
    replace() { connection = { ...connection }; },
    replaceServer() { server = { getOrigin: () => origin }; },
    changeOrigin(value: string) { origin = value; },
    removeServer() { server = undefined; },
    reject(value: number) { rejection = value; },
    failServer() { server = { getOrigin() { throw Error('not listening'); } }; } };
}
test('个人面板只允许当前浏览器所有者读取，写入需要本宿主凭证', async () => {
  const f = fixture();
  let writes = 0;
  f.control.personalRead = async caller => { caller.assertCurrent(); return {ok:true,todos:[]}; };
  f.control.personalWrite = async (session, value, caller) => {
    caller.assertCurrent(); writes++; assert.equal(session,'steward'); assert.deepEqual(value,{op:'create'}); return {ok:true};
  };
  const read = (credential: string) => f.routes.personalRead(new Request('http://dsh.internal/api/workspace-superagent/personal', {
    headers:{'x-test-credential':credential},
  }));
  assert.equal((await read('api')).status,403);
  assert.equal((await read('browser')).status,200);
  const health = await f.routes.read(new Request('http://dsh.internal/api/workspace-superagent/health', {headers:{'x-test-credential':'browser'}}));
  const token = health.headers.get(CONTROL_TOKEN_HEADER)!;
  const body = { sessionId:'steward',request:{op:'create'} };
  assert.equal((await f.routes.personalWrite(f.request(body))).status,403);
  const good = f.request(body); good.headers.set(CONTROL_TOKEN_HEADER,token);
  assert.equal((await f.routes.personalWrite(good)).status,200);
  const foreign = f.request(body,'browser','https://foreign.invalid'); foreign.headers.set(CONTROL_TOKEN_HEADER,token);
  assert.equal((await f.routes.personalWrite(foreign)).status,403);
  assert.equal(writes,1);
});
test('GenUI 视图路由要求当前浏览器所有者与宿主控制凭证，并正确映射错误码', async () => {
  const f = fixture();
  let calls = 0;
  f.control.genui = async (session, value, caller) => {
    caller.assertCurrent();
    calls++;
    assert.equal(session, 'steward');
    const op = (value as { op?: string })?.op;
    if (op === 'invalid') throw Error('INVALID_GENUI_COMPONENT:BadComp');
    if (op === 'missing') throw Error('GENUI_VIEW_NOT_FOUND');
    return [{ id: 'view-1', turn: 0, revision: 1, schema: { componentName: 'GenuiCard' }, nodeCount: 1, status: 'active', createdAt: 1 }];
  };
  const health = await f.routes.read(new Request('http://dsh.internal/api/workspace-superagent/health', {
    headers: { 'x-test-credential': 'browser' },
  }));
  const token = health.headers.get(CONTROL_TOKEN_HEADER)!;
  const body = { sessionId: 'steward', request: { op: 'list', turn: 0 } };
  assert.equal((await f.routes.genui(f.request(body))).status, 403);
  const authed = (reqBody: unknown) => {
    const req = f.request(reqBody);
    req.headers.set(CONTROL_TOKEN_HEADER, token);
    return req;
  };
  const okResp = await f.routes.genui(authed(body));
  assert.equal(okResp.status, 200);
  const okJson = await okResp.json() as { ok: boolean; views: { id: string }[] };
  assert.equal(okJson.ok, true);
  assert.equal(okJson.views[0]?.id, 'view-1');
  assert.equal((await f.routes.genui(authed({ sessionId: 'steward', request: { op: 'invalid' } }))).status, 400);
  assert.equal((await f.routes.genui(authed({ sessionId: 'steward', request: { op: 'missing' } }))).status, 404);
  assert.equal(calls, 3);
});
test('个人面板明确提示授权到期，其他错误不泄露内部信息', async () => {
  const f = fixture();
  const read = () => f.routes.personalRead(new Request('http://dsh.internal/api/workspace-superagent/personal', {
    headers: {'x-test-credential':'browser'},
  }));
  f.control.personalRead = async () => { throw Error('PERSONAL_AUTH_EXPIRED'); };
  const expired = await read();
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).error, '主理只读授权已到期，请更新授权后重试。');
  f.control.personalRead = async () => { throw Error('private details'); };
  const failed = await read();
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, '个人面板暂时无法读取。');
});
test('组件认证端口：无认证/API owner/异源/额外字段/旧revision均拒', async () => {
  const f = fixture();
  assert.equal((await f.routes.control(f.request(undefined, 'none'))).status, 403);
  assert.equal((await f.routes.control(f.request(undefined, 'api'))).status, 403);
  assert.equal((await f.routes.control(f.request(undefined, 'browser', 'https://foreign.invalid'))).status, 403);
  assert.equal((await f.routes.control(f.request({ action:'resume', revision:1, human:true }))).status, 400);
  assert.equal((await f.routes.control(f.request())).status,200);
  assert.equal((await f.routes.control(f.request())).status,409);
  assert.equal(f.calls(),1);
});
test('桌面代理去除来源头后，只有当前浏览器所有者持宿主发出的凭证可控制', async () => {
  const f = fixture();
  const read = (credential: string) => f.routes.read(new Request('http://dsh.internal/api/workspace-superagent/health', {
    headers: { 'x-test-credential': credential },
  }));
  for (const credential of ['none', 'api']) {
    const denied = await read(credential);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.has(CONTROL_TOKEN_HEADER), false);
  }
  const health = await read('browser');
  const token = health.headers.get(CONTROL_TOKEN_HEADER);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.ok(token);
  const request = (proof?: string, credential = 'browser') => {
    const req = f.request({ action: 'resume', revision: 1 }, credential);
    req.headers.delete('origin');
    req.headers.delete('sec-fetch-site');
    if (proof) req.headers.set(CONTROL_TOKEN_HEADER, proof);
    return req;
  };
  const explicitForeign = request(token);
  explicitForeign.headers.set('origin', 'https://foreign.invalid');
  const explicitCrossSite = request(token);
  explicitCrossSite.headers.set('sec-fetch-site', 'cross-site');
  for (const req of [request(), request('wrong'), request(token, 'api'), explicitForeign, explicitCrossSite]) {
    assert.equal((await f.routes.control(req)).status, 403);
  }
  assert.equal((await fixture().routes.control(request(token))).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal((await f.routes.control(request(token))).status, 200);
  assert.equal((await f.routes.control(request(token))).status, 409);
  assert.equal(f.calls(), 1);
});
test('聊天写入口校验所有者、来源和精确请求字段', async () => {
  const f = fixture();
  const messages: string[] = [];
  f.control.send = async (sessionId, requestId, text, caller) => {
    caller.assertCurrent();
    assert.equal(sessionId, 'steward');
    assert.equal(requestId, '00000000-0000-4000-8000-000000000000');
    messages.push(text);
  };
  const message = { sessionId: 'steward', requestId: '00000000-0000-4000-8000-000000000000', text: '看板进展' };
  assert.equal((await f.routes.chat(f.request(message, 'api'))).status, 403);
  assert.equal((await f.routes.chat(f.request(message, 'browser', 'https://foreign.invalid'))).status, 403);
  assert.equal((await f.routes.chat(f.request({ ...message, model: 'alternate' }))).status, 400);
  assert.equal((await f.routes.chat(f.request({ ...message, text: '  ' }))).status, 400);
  assert.equal((await f.routes.chat(f.request(message))).status, 200);
  assert.deepEqual(messages, ['看板进展']);
});
test('原生输入框发送与选模均经所有者校验', async () => {
  const f = fixture(), sessionId = 'steward', requestId = '00000000-0000-4000-8000-000000000000';
  const content = [{ type: 'text', text: '继续对话' }, { type: 'file', receiptId: 'uploaded-file' }];
  const model = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' };
  const seen: unknown[] = [];
  f.control.sendContent = async (id, request, parts, caller) => {
    caller.assertCurrent();
    seen.push([id, request, parts]);
  };
  f.control.selectModel = async (id, selection, caller) => {
    caller.assertCurrent();
    seen.push([id, selection]);
  };
  assert.equal((await f.routes.chat(f.request({ sessionId, requestId, content }, 'api'))).status, 403);
  assert.equal((await f.routes.chat(f.request({ sessionId, model }, 'browser', 'https://foreign.invalid'))).status, 403);
  assert.equal((await f.routes.chat(f.request({ sessionId, requestId, content: [{ type: 'file', path: '/tmp/file' }] }))).status, 400);
  assert.equal((await f.routes.chat(f.request({ sessionId, model: { ...model, reasoningEffort: null } }))).status, 400);
  assert.equal((await f.routes.chat(f.request({ sessionId, requestId, content }))).status, 200);
  assert.equal((await f.routes.chat(f.request({ sessionId, model }))).status, 200);
  assert.deepEqual(seen, [[sessionId, requestId, content], [sessionId, model]]);
});
test('初次使用引导连接与 Soul 设定均经所有者与字段校验', async () => {
  const f = fixture(), sessionId = 'steward';
  const model = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' };
  const soul = { preset: 'efficient', userName: '开水', prompt: '结论先行，清晰简洁。' };
  const seen: unknown[] = [];
  f.control.connect = async (revision, _proof, caller, options) => {
    caller.assertCurrent();
    seen.push(['connect', revision, options]);
  };
  f.control.selectSoul = async (id, nextSoul, caller) => {
    caller.assertCurrent();
    seen.push(['soul', id, nextSoul]);
  };
  assert.equal((await f.routes.chat(f.request({ revision: 1, model, soul }, 'api'))).status, 403);
  assert.equal((await f.routes.chat(f.request({ revision: 1, model, soul: { preset: 'invalid', prompt: 'x' } }))).status, 400);
  assert.equal((await f.routes.chat(f.request({ sessionId, soul: { preset: 'warm', prompt: '  ' } }))).status, 400);
  assert.equal((await f.routes.chat(f.request({ revision: 1, model, soul }))).status, 200);
  assert.equal((await f.routes.chat(f.request({ sessionId, soul }))).status, 200);
  assert.deepEqual(seen, [['connect', 1, { model, soul }], ['soul', sessionId, soul]]);
});
test('聊天入口支持动态 suggestions 拉取、引导记忆注入与大肥鱼重置', async () => {
  const f = fixture();
  const seen: unknown[] = [];
  f.control.suggestions = async () => ({
    dailyReviewConfigured: false,
    items: [{ id: 'daily-schedule', label: '开启每日早晚总结与复盘', icon: 'clock', prompt: 'p', primary: true }],
  });
  f.control.reset = (rev, proofRef, caller) => {
    caller.assertCurrent();
    seen.push(['reset', rev, Boolean(proofRef)]);
  };
  f.control.connect = async (rev, _proofRef, caller, options) => {
    caller.assertCurrent();
    seen.push(['connect', rev, options]);
  };
  const sugResp = await f.routes.chat(f.request({ suggestions: true }));
  assert.equal(sugResp.status, 200);
  const sugBody = await sugResp.json() as { ok: boolean; suggestions: { dailyReviewConfigured: boolean; items: { id: string }[] } };
  assert.equal(sugBody.ok, true);
  assert.equal(sugBody.suggestions.items[0]?.id, 'daily-schedule');

  assert.equal((await f.routes.chat(f.request({ reset: true, revision: 1 }, 'api'))).status, 403);
  assert.equal((await f.routes.chat(f.request({ reset: true, revision: 1 }))).status, 200);

  const soul = {
    preset: 'efficient' as const,
    botName: '胖虎鱼',
    avatarDataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    userName: '凯哥',
    prompt: '先给结论',
    traits: ['conclusion-first' as const, 'blunt-risk' as const],
    syncSoulMarkdown: true,
  };
  const onboardingMemory = {
    sources: ['rules' as const, 'sessions' as const],
    customNote: '习惯早上 9:30 规划今日重点',
  };
  assert.equal((await f.routes.chat(f.request({ revision: 1, soul: { ...soul, avatarDataUrl: 'https://evil.example/a.gif' } }))).status, 400);
  assert.equal((await f.routes.chat(f.request({ revision: 1, soul, onboardingMemory }))).status, 200);
  assert.deepEqual(seen, [
    ['reset', 1, true],
    ['connect', 1, { soul, onboardingMemory }],
  ]);
  const promptText = formatSoulPrompt(soul);
  assert.ok(promptText.includes('胖虎鱼'));
  const markdownDoc = renderSoulMarkdownDocument(soul);
  assert.ok(markdownDoc.includes('胖虎鱼'));
  const customizedSoul = {
    ...soul,
    traitsMarkdown: '- **结论先行**：先输出一句话 TL;DR，再附验证命令。\n- **自定义规范**：所有代码变更需附回归测试。',
  };
  assert.ok(formatSoulPrompt(customizedSoul).includes('先输出一句话 TL;DR，再附验证命令。'));
  assert.ok(renderSoulMarkdownDocument(customizedSoul).includes('所有代码变更需附回归测试。'));
});
test('body await后Peer、connection、监听地址提供者换代或失效均拒控制', async () => {
  for (const kind of ['peer','connection','webServer','origin','missingOrigin']) {
    const f = fixture(), gate = deferred<string>(), request = f.request();
    request.text = () => gate.promise;
    const pending = f.routes.control(request);
    if (kind === 'peer') f.ownerAbort.abort();
    else if (kind === 'connection') f.replace();
    else if (kind === 'webServer') f.replaceServer();
    else if (kind === 'origin') f.changeOrigin('http://127.0.0.1:4321');
    else f.removeServer();
    gate.resolve('{"action":"resume","revision":1}');
    assert.equal((await pending).status,403); assert.equal(f.calls(),0);
  }
});
test('可信完整origin：错scheme/port、缺失/异常提供者和宿主拒绝均不执行', async () => {
  for (const origin of ['https://127.0.0.1:1234', 'http://127.0.0.1:4321', 'http://127.0.0.1:1234/', 'null']) {
    const f = fixture();
    assert.equal((await f.routes.control(f.request(undefined, 'browser', origin))).status, 403);
    assert.equal(f.calls(), 0);
  }
  for (const kind of ['missing', 'throws', 'invalid', 'hostRejected']) {
    const f = fixture();
    if (kind === 'missing') f.removeServer();
    else if (kind === 'throws') f.failServer();
    else if (kind === 'invalid') f.changeOrigin('file:///private/tmp');
    else f.reject(403);
    assert.equal((await f.routes.control(f.request())).status, 403);
    assert.equal(f.calls(), 0);
  }
});
