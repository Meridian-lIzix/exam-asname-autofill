const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../ai-client.js');

const question = (id, type = 1) => ({ question_id: id, type, question: '测试题干', options: [{ key: 'A', text: '选项甲' }, { key: 'B', text: '选项乙' }] });
const config = { baseUrl: 'https://example.com/custom/v1/', apiKey: 'fixture-key', model: 'fixture-model', enabled: true };

test('批次设置默认30题并发2，允许范围内自定义并拒绝非法值', () => {
  assert.deepEqual(ai.normalizeBatchSettings(), { batchSize: 30, concurrency: 2 });
  assert.deepEqual(ai.normalizeBatchSettings({ batchSize: 40, concurrency: 3 }), { batchSize: 40, concurrency: 3 });
  assert.deepEqual(ai.DEFAULT_BATCH_SETTINGS, { batchSize: 30, concurrency: 2 });
  assert.deepEqual(ai.MAX_BATCH_SETTINGS, { batchSize: 100, concurrency: 10 });
  for (const value of [null, [], { batchSize: 0 }, { batchSize: 101 }, { batchSize: 1.5 }, { concurrency: 0 }, { concurrency: 11 }, { concurrency: 2.5 }]) assert.throws(() => ai.normalizeBatchSettings(value), /批次设置|每组题数|AI 并发/);
});

test('保留BaseURL自定义路径、规范化完整接口地址', () => {
  assert.equal(ai.normalizeConfig(config).baseUrl, 'https://example.com/custom/v1');
  assert.equal(ai.normalizeConfig({ ...config, baseUrl: 'https://example.com/custom/v1/chat/completions' }).baseUrl, 'https://example.com/custom/v1');
  assert.equal(ai.normalizeConfig({ ...config, baseUrl: 'http://127.0.0.1:9000/v1', apiKey: '' }).apiKey, '');
});

test('拒绝不安全地址、URL内凭证及非法配置', () => {
  for (const baseUrl of ['http://remote.example/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'file:///v1', 'not a url']) assert.throws(() => ai.normalizeConfig({ ...config, baseUrl }));
  assert.throws(() => ai.normalizeConfig({ ...config, apiKey: '' }), /Key/);
  assert.throws(() => ai.normalizeConfig({ ...config, model: '' }), /模型/);
  assert.throws(() => ai.normalizeConfig({ ...config, apiKey: 'a\nb' }), /Key/);
});

test('组大小限30且拒绝重复题号、非法选项', () => {
  ai.validateQuestions(Array.from({ length: 30 }, (_, index) => question('q' + index)));
  assert.throws(() => ai.validateQuestions(Array.from({ length: 31 }, (_, index) => question('q' + index))), /30/);
  ai.validateQuestions(Array.from({ length: 100 }, (_, index) => question('q' + index)), 100);
  assert.throws(() => ai.validateQuestions(Array.from({ length: 101 }, (_, index) => question('q' + index)), 100), /100/);
  assert.throws(() => ai.validateQuestions([question('q1'), question('q1')]), /重复/);
  assert.throws(() => ai.validateQuestions([{ ...question('q1'), options: [{ key: 'A', text: 'a' }, { key: 'A', text: 'b' }] }]), /选项/);
});

test('乱序返回按题号对应，漏题和非法选项仅进入错误列表', () => {
  const questions = [question('q1'), question('q2', 2), question('q3'), question('q4')];
  const result = ai.parseAnswers(JSON.stringify({ answers: [{ question_id: 'q2', answers: ['B', 'A'] }, { question_id: 'q1', answers: ['B'] }, { question_id: 'q4', answers: ['Z'] }] }), questions);
  assert.deepEqual(result.answers, [{ question_id: 'q1', answers: ['B'] }, { question_id: 'q2', answers: ['A', 'B'] }]);
  assert.deepEqual(result.errors.map((item) => item.question_id), ['q3', 'q4']);
});

test('拒绝多余ID、重复ID和不完整JSON', () => {
  const q = [question('q1')];
  assert.throws(() => ai.parseAnswers('{"answers":', q), /完整 JSON/);
  assert.throws(() => ai.parseAnswers('{"answers":[{"question_id":"foreign","answers":["A"]}]}', q), /不属于/);
  assert.throws(() => ai.parseAnswers('{"answers":[{"question_id":"q1","answers":["A"]},{"question_id":"q1","answers":["B"]}]}', q), /重复/);
  assert.equal(ai.parseAnswers('{"answers":[{"question_id":"q1","answers":["A","B"]}]}', q).errors.length, 1);
});

test('流式响应跨分片保持JSON内容完整', async () => {
  const answer = '{"answers":[{"question_id":"q1","answers":["A"]}]}';
  const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(0, 18) }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(18) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close(); } });
  assert.equal(await ai.readCompletion(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), answer);
});

test('兼容服务返回非流式JSON时可以读取，截断和拒绝响应报错', async () => {
  const response = (finish, refusal = null) => new Response(JSON.stringify({ choices: [{ message: { content: '{}', refusal }, finish_reason: finish }] }), { headers: { 'content-type': 'application/json' } });
  assert.equal(await ai.readCompletion(response('stop')), '{}');
  await assert.rejects(ai.readCompletion(response('length')), /未完整/);
  await assert.rejects(ai.readCompletion(response('stop', 'refused')), /未提供/);
  await assert.rejects(ai.readCompletion(response(null)), /完整答案/);
});
