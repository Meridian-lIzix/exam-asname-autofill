const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');
const engine = require('../engine.js');

const now = Math.floor(Date.now() / 1000);
const row = (overrides = {}) => ({ exam_id: 18, exam_name: '每周测试5（9/5）', type: 2, is_end: 0, s_time: now - 60, e_time: now + 3600, now_time: now, ...overrides });
const exam = engine.identifyExam(row());
const detail = (overrides = {}) => ({ id: 123, name: '哪一项是水？', type: 1, options: '[{"A":"氧气"},{"B":"水"},{"C":"氮气"}]', answer: '', r_answer: '', ...overrides });
const record = { ...core.normalizeQuestion(exam, detail()), answer: 'B', answer_source: 'ai' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('自动识别每周测试、知识练习，未知场次不显示', () => {
  assert.equal(engine.identifyExam(row()).mode, 'test');
  assert.equal(engine.identifyExam(row({ exam_name: '知识练习A' })).mode, 'practice');
  assert.equal(engine.identifyExam(row({ exam_name: '知识练习阶段测试' })).mode, 'test');
  assert.equal(engine.identifyExam(row({ exam_name: '未知活动' })), null);
  assert.equal(engine.identifyExam(row({ type: 1 })), null);
  assert.equal(engine.identifyExam(row({ type: 4 })), null);
});

test('过滤未开放、已过期、已交卷和缺少有效时间的场次', () => {
  assert.equal(engine.identifyExam(row({ s_time: now + 1 })), null);
  assert.equal(engine.identifyExam(row({ e_time: now - 1 })), null);
  assert.equal(engine.identifyExam(row({ is_end: '2' })), null);
  assert.equal(engine.identifyExam(row({ s_time: undefined })), null);
  assert.equal(engine.identifyExam(row({ e_time: undefined })), null);
  assert.equal(engine.identifyExam(row({ s_time: now * 1000 - 1000, e_time: now * 1000 + 1000 })).mode, 'test');
});

test('子场次沿用分组名称，且必须处于父场次开放时段', () => {
  const child = row({ exam_name: '理论部分', subtitle: '理论', exam_id: 19 });
  const parent = row();
  assert.equal(engine.identifyExam(child, parent).name, '每周测试5（9/5） · 理论');
  assert.equal(engine.identifyExam(child, row({ e_time: now - 1 })), null);
  assert.equal(engine.identifyExam(child, row({ is_end: 2 })), null);
});

test('30题分组、最多2组并发，第二组先完成立即派发第三组', async () => {
  const items = Array.from({ length: 95 }, (_, index) => index);
  const started = [];
  const releases = [];
  let active = 0;
  let peak = 0;
  const work = engine.runBatches(items, async (batch, index) => {
    started.push({ index, batch });
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => { releases[index] = resolve; });
    active -= 1;
    return batch.length;
  });
  await tick();
  assert.deepEqual(started.map((item) => item.batch.length), [30, 30]);
  releases[1]();
  await tick();
  assert.deepEqual(started.map((item) => item.index), [0, 1, 2]);
  releases[2]();
  await tick();
  assert.equal(started[3].batch.length, 5);
  releases[3]();
  releases[0]();
  const results = await work;
  assert.equal(peak, 2);
  assert.deepEqual(results.map((item) => item.value), [30, 30, 30, 5]);
  assert.deepEqual(started.flatMap((item) => item.batch).sort((a, b) => a - b), items);
});

test('40题分组和并发3会实际同时运行3组并及时补位', async () => {
  const items = Array.from({ length: 125 }, (_, index) => index);
  const started = [];
  const releases = [];
  let active = 0;
  let peak = 0;
  const work = engine.runBatches(items, async (batch, index) => {
    started.push({ index, batch });
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => { releases[index] = resolve; });
    active -= 1;
    return batch.length;
  }, () => false, { batchSize: 40, concurrency: 3 });
  await tick();
  assert.deepEqual(started.map((item) => item.batch.length), [40, 40, 40]);
  releases[1]();
  await tick();
  assert.equal(started[3].batch.length, 5);
  releases[0]();
  releases[2]();
  releases[3]();
  const results = await work;
  assert.equal(peak, 3);
  assert.deepEqual(results.map((item) => item.value), [40, 40, 40, 5]);
});

test('5题分组和并发1会保持串行', async () => {
  const started = [];
  const releases = [];
  let active = 0;
  let peak = 0;
  const work = engine.runBatches(Array.from({ length: 12 }), async (batch, index) => {
    started.push(index);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => { releases[index] = resolve; });
    active -= 1;
    return batch.length;
  }, () => false, { batchSize: 5, concurrency: 1 });
  await tick();
  assert.deepEqual(started, [0]);
  releases[0]();
  await tick();
  assert.deepEqual(started, [0, 1]);
  releases[1]();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  releases[2]();
  assert.deepEqual(await work, [{ ok: true, value: 5 }, { ok: true, value: 5 }, { ok: true, value: 2 }]);
  assert.equal(peak, 1);
});

test('引擎拒绝非法批次设置', async () => {
  assert.throws(() => engine.normalizeBatchSettings({ batchSize: 101 }), /每组题数/);
  assert.throws(() => engine.normalizeBatchSettings({ concurrency: 11 }), /AI 并发/);
  await assert.rejects(engine.runBatches([], async () => undefined, () => false, { batchSize: 0 }), /每组题数/);
});

test('停止后不再派发后续AI分组', async () => {
  let stopped = false;
  const releases = [];
  let started = 0;
  const work = engine.runBatches(Array.from({ length: 100 }), async (_, index) => {
    started += 1;
    await new Promise((resolve) => { releases[index] = resolve; });
  }, () => stopped);
  await tick();
  stopped = true;
  releases[0]();
  releases[1]();
  await work;
  assert.equal(started, 2);
});

test('网站题号错配时拒绝读取', () => {
  assert.throws(() => engine.readQuestion(exam, detail({ id: 124 }), 123), /ID/);
  assert.throws(() => engine.readQuestion(exam, detail({ answer: 'Z' }), 123), /非法/);
});

test('重新读取时选项换序，答案按内容映射后提交并回读', async () => {
  let submitted;
  const reordered = detail({ options: '[{"A":"水"},{"B":"氮气"},{"C":"氧气"}]' });
  const api = {
    select: async () => ({ ...reordered, answer: submitted || '' }),
    submit: async (examId, questionId, answer) => { assert.equal(examId, 18); assert.equal(questionId, 123); submitted = answer; }
  };
  const result = await engine.submitVerified(exam, record, 'B', api);
  assert.equal(submitted, 'A');
  assert.equal(result.submission_status, 'verified');
  assert.equal(result.answer, 'A');
  assert.equal(result.answer_source, 'ai');
});

test('网站已经保存预期答案时不重复提交', async () => {
  const result = await engine.submitVerified(exam, record, 'B', {
    select: async () => detail({ answer: 'B' }),
    submit: async () => { throw new Error('unexpected write'); }
  });
  assert.equal(result.submission_status, 'verified');
});

test('新取得的官方答案优先于AI答案', async () => {
  let submitted;
  const result = await engine.submitVerified(exam, record, 'B', {
    select: async () => detail({ answer: submitted || '', r_answer: 'C' }),
    submit: async (_, __, answer) => { submitted = answer; }
  });
  assert.equal(submitted, 'C');
  assert.equal(result.answer_source, 'official');
});

test('提交拒绝、假成功、内容变化都不能标记已完成', async () => {
  await assert.rejects(engine.submitVerified(exam, record, 'B', { select: async () => detail(), submit: async () => { throw new Error('网站拒绝'); } }), /网站拒绝/);
  await assert.rejects(engine.submitVerified(exam, record, 'B', { select: async () => detail(), submit: async () => {} }), /不一致/);
  await assert.rejects(engine.submitVerified(exam, record, 'B', { select: async () => detail({ name: '新题目' }), submit: async () => { throw new Error('unexpected write'); } }), /内容已经变化/);
});

test('停止或场次到期后不执行作答请求', async () => {
  const api = { select: async () => { throw new Error('unexpected read'); }, submit: async () => { throw new Error('unexpected write'); } };
  await assert.rejects(engine.submitVerified(exam, record, 'B', api, () => true), /停止/);
  await assert.rejects(engine.submitVerified({ ...exam, end: now - 1 }, record, 'B', api), /已结束/);
});
