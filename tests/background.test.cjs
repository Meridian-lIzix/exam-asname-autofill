const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const settings = { baseUrl: 'https://fixture.example/v1', apiKey: 'fixture-secret', model: 'fixture-model', enabled: true };
const question = (id) => ({ question_id: id, type: 1, question: '示例题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] });
const questions = (count, prefix = '18:') => Array.from({ length: count }, (_, index) => question(prefix + (index + 1)));
const page = { id: 'extension-id', url: 'https://exam.asname.cn/theory', tab: { id: 1 } };
const options = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
const embeddedOptions = { ...options, url: options.url + '?embedded=1' };
const completion = (questions, key = 'B') => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: questions.map((item) => ({ question_id: item.question_id, answers: [key] })) }) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });

function runtime(fetcher, allowed = true) {
  let listener;
  let stored = { ...settings };
  let access;
  const context = vm.createContext({
    URL, Map, Set, AbortController, TextDecoder, console, fetch: fetcher, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => undefined,
    chrome: {
      storage: { local: { setAccessLevel: async (value) => { access = value; }, get: async () => ({ aiSettings: stored }), set: async ({ aiSettings }) => { stored = aiSettings; } } },
      permissions: { contains: async () => allowed },
      runtime: { id: 'extension-id', getURL: (file) => 'chrome-extension://extension-id/' + file, getPlatformInfo: async () => ({}), openOptionsPage: async () => undefined, onMessage: { addListener: (handler) => { listener = handler; } } }
    }
  });
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context, { filename: 'background.js' });
  const send = (type, payload = {}, sender = page) => new Promise((resolve) => listener({ channel: 'exam-autofill', type, ...payload }, sender, resolve));
  return { send, access: () => access };
}

test('网页不能读取密钥，状态不泄露配置，外部来源不能调用后台', async () => {
  const app = runtime(async () => { throw new Error('unexpected network'); });
  assert.equal((await app.send('getSettings')).ok, false);
  const status = await app.send('getStatus');
  assert.equal(status.ok, true);
  assert(!JSON.stringify(status).includes('fixture-secret'));
  assert.equal((await app.send('getSettings', {}, options)).data.settings.apiKey, settings.apiKey);
  assert.equal((await app.send('getStatus', {}, { ...page, url: 'https://attacker.example/' })).ok, false);
  assert.equal((await app.send('testConnection', {}, page)).ok, false);
  assert.equal(app.access().accessLevel, 'TRUSTED_CONTEXTS');
});

test('设置页和嵌入设置页可以测试已保存模型并校验示例答案', async () => {
  let calls = 0;
  const app = runtime(async (url, request) => {
    calls += 1;
    assert.equal(url, settings.baseUrl + '/chat/completions');
    const body = JSON.parse(request.body);
    const questions = JSON.parse(body.messages[1].content).questions;
    assert.deepEqual(questions, [{ question_id: 'connection-test-1', type: 1, question: '1 + 1 等于？', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }, { key: 'D', text: '4' }] }]);
    return completion(questions);
  });
  const result = await app.send('testConnection', {}, options);
  assert.equal(result.ok, true);
  assert.equal(result.data.tested, true);
  assert.equal(result.data.model, settings.model);
  assert.equal(typeof result.data.elapsedMs, 'number');
  assert.equal((await app.send('testConnection', {}, embeddedOptions)).ok, true);
  assert.equal(calls, 2);
});

test('设置页来源按扩展身份核验，兼容缺少URL和继承扩展来源的框架', async () => {
  const app = runtime(async (_, request) => completion(JSON.parse(JSON.parse(request.body).messages[1].content).questions));
  const origin = 'chrome-extension://extension-id';
  const senders = [
    { ...options, origin, url: options.url + '?embedded=1#settings' },
    { id: options.id, origin },
    { id: options.id, origin, url: 'about:blank' },
    { id: options.id, origin, url: 'about:srcdoc' }
  ];
  for (const sender of senders) {
    assert.equal((await app.send('getSettings', {}, sender)).ok, true);
    assert.equal((await app.send('saveSettings', { settings }, sender)).ok, true);
    assert.equal((await app.send('testConnection', {}, sender)).ok, true);
  }
});

test('网站来源的空白框架、伪装设置地址和其他扩展仍不能读写密钥', async () => {
  const app = runtime(async () => { throw new Error('unexpected network'); });
  const senders = [
    { ...page, url: 'about:srcdoc', origin: 'https://exam.asname.cn' },
    { ...options, origin: 'https://exam.asname.cn' },
    { id: options.id, origin: 'https://exam.asname.cn' },
    { id: options.id, origin: 'null', url: 'about:blank' },
    { ...options, url: 'chrome-extension://other-id/options.html', origin: 'chrome-extension://other-id' },
    { ...options, id: 'other-id' },
    { ...options, url: 'not-a-url' }
  ];
  for (const sender of senders) {
    assert.equal((await app.send('getSettings', {}, sender)).ok, false);
    assert.equal((await app.send('saveSettings', { settings }, sender)).ok, false);
    assert.equal((await app.send('testConnection', {}, sender)).ok, false);
  }
});

test('测试 AI 拒绝错误的示例答案且不泄露密钥', async () => {
  const app = runtime(async (_, request) => completion(JSON.parse(JSON.parse(request.body).messages[1].content).questions, 'A'));
  const result = await app.send('testConnection', {}, options);
  assert.equal(result.ok, false);
  assert.match(result.error, /B=2/);
  assert(!result.error.includes(settings.apiKey));
});

test('按已配置地址发请求，不携带网站凭证，禁止重定向', async () => {
  const app = runtime(async (url, request) => {
    assert.equal(url, settings.baseUrl + '/chat/completions');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.headers.Authorization, 'Bearer fixture-secret');
    const body = JSON.parse(request.body);
    const questions = JSON.parse(body.messages[1].content).questions;
    assert.equal(body.stream, true);
    assert.equal(body.response_format.type, 'json_schema');
    return completion(questions);
  });
  const result = await app.send('solveBatch', { runId: 'run', batchId: 'b1', questions: [question('18:1')], url: 'https://attacker.example/' });
  assert.equal(result.ok, true);
  assert.equal(result.data.answers[0].question_id, '18:1');
});

test('不支持结构化输出时仅降级格式，保持题目和本地校验', async () => {
  const modes = [];
  const app = runtime(async (_, request) => {
    const body = JSON.parse(request.body);
    modes.push(body.response_format?.type || 'text');
    if (body.response_format?.type === 'json_schema') return new Response('{"error":{"message":"response_format json_schema is not supported"}}', { status: 400 });
    return completion(JSON.parse(body.messages[1].content).questions);
  });
  const result = await app.send('solveBatch', { runId: 'run', batchId: 'b1', questions: [question('18:1')] });
  assert.equal(result.ok, true);
  assert.deepEqual(modes, ['json_schema', 'json_object']);
});

test('跨页面总并发上限为2，完成后立即接续排队组', async () => {
  let active = 0;
  let peak = 0;
  const released = [];
  const started = [];
  const app = runtime(async (_, request) => {
    const questions = JSON.parse(JSON.parse(request.body).messages[1].content).questions;
    const id = questions[0].question_id;
    peak = Math.max(peak, ++active);
    started.push(id);
    await new Promise((resolve) => { released.push(resolve); });
    active -= 1;
    return completion(questions);
  });
  const jobs = ['18:1', '18:2', '18:3'].map((id, index) => app.send('solveBatch', { runId: 'run', batchId: 'b' + index, questions: [question(id)] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 2);
  released[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 3);
  released[2]();
  released[0]();
  const results = await Promise.all(jobs);
  assert(results.every((result) => result.ok));
  assert.equal(peak, 2);
});

test('批次设置允许40题且后台并发3真实生效，超过100题或非法设置会拒绝', async () => {
  let active = 0;
  let peak = 0;
  const released = [];
  const started = [];
  const app = runtime(async (_, request) => {
    const batch = JSON.parse(JSON.parse(request.body).messages[1].content).questions;
    started.push(batch.length);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => { released.push(resolve); });
    active -= 1;
    return completion(batch);
  });
  const jobs = [0, 1, 2].map((index) => app.send('solveBatch', { runId: 'run-custom', batchId: 'b' + index, batchSettings: { batchSize: 40, concurrency: 3 }, questions: questions(40, 'custom:' + index + ':') }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [40, 40, 40]);
  released.forEach((resolve) => resolve());
  assert((await Promise.all(jobs)).every((result) => result.ok));
  assert.equal(peak, 3);
  const tooMany = await app.send('solveBatch', { runId: 'run-custom', batchId: 'too-many', batchSettings: { batchSize: 100, concurrency: 3 }, questions: questions(101, 'too-many:') });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /100/);
  const invalid = await app.send('solveBatch', { runId: 'run-custom', batchId: 'invalid', batchSettings: { batchSize: 40, concurrency: 11 }, questions: questions(1, 'invalid:') });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /AI 并发/);
});

test('认证失败不重复调用，未授权域名不发请求', async () => {
  let calls = 0;
  const app = runtime(async () => { calls++; return new Response('{"error":"fixture-secret"}', { status: 401 }); });
  const result = await app.send('solveBatch', { runId: 'run', batchId: 'b1', questions: [question('18:1')] });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert(!result.error.includes('fixture-secret'));
  const denied = runtime(async () => { throw new Error('unexpected network'); }, false);
  assert.equal((await denied.send('solveBatch', { runId: 'run', batchId: 'b1', questions: [question('18:1')] })).ok, false);
});

test('停止当前运行会取消在途AI请求', async () => {
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const app = runtime(async (_, { signal }) => {
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const job = app.send('solveBatch', { runId: 'run', batchId: 'b1', questions: [question('18:1')] });
  await start;
  assert.equal((await app.send('cancelRun', { runId: 'run' })).ok, true);
  const result = await job;
  assert.equal(result.ok, false);
  assert.match(result.error, /停止/);
});
