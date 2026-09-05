const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const project = process.argv[2] || path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8'));
const contentScripts = [...new Set(manifest.content_scripts.flatMap((script) => script.js || []))];
const source = Object.fromEntries(contentScripts.map((name) => [name, fs.readFileSync(path.join(project, name), 'utf8')]));
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

async function until(check, label) {
  for (let index = 0; index < 1000; index += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error('Timeout: ' + label);
}

function record(overrides = {}) {
  return {
    exam_id: 9,
    exam_name: '知识练习A',
    question_id: 2612,
    type: 2,
    type_name: '多选题',
    question: '以下哪些是正确选项？',
    options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }, { key: 'C', text: '丙' }],
    score: '2.00',
    answer: 'A,B',
    answer_source: 'official',
    ...overrides
  };
}

function createApp(vault = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://exam.asname.cn/theory', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const now = Math.floor(Date.now() / 1000);
  const rows = [{ exam_id: 18, exam_name: '每周测试5（9/5）', type: 2, is_end: 0, s_time: now - 10, e_time: now + 3600, now_time: now }];
  const timers = [];
  const nativeSetInterval = w.setInterval.bind(w);
  w.setInterval = (fn, delay) => {
    const timer = nativeSetInterval(fn, delay);
    timers.push(timer);
    return timer;
  };
  w.localStorage.setItem('exam-autofill:vault', JSON.stringify(vault));
  w.sessionStorage.setItem('login-fixture', 'eyJ.fixture.value');
  Object.defineProperty(w.navigator, 'locks', { value: { request: async (_, options, worker) => worker({ name: 'test-lock' }) } });
  w.chrome = { runtime: { getURL: (file) => 'chrome-extension://extension-id/' + file, sendMessage: async (message) => {
    if (message.type === 'getStatus') return { ok: true, data: { enabled: false, model: 'fixture' } };
    throw new Error('Unexpected message ' + message.type);
  } } };
  w.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send() {
      Promise.resolve().then(() => {
        const data = this.url.startsWith('/api/homepage/indexdata') ? rows : [];
        this.status = 200;
        this.responseText = JSON.stringify({ code: 1, data });
        this.onload();
      });
    }
  };
  for (const name of contentScripts) w.eval(source[name]);
  return { dom, w, close: () => { for (const timer of timers) w.clearInterval(timer); dom.window.close(); } };
}

async function importPayload(app, payload, expected = /题库导入完成|无效/, size = JSON.stringify(payload).length) {
  const input = app.w.document.querySelector('[data-role="import-file"]');
  const file = { name: '题库.json', size, text: async () => JSON.stringify(payload) };
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await tick();
  await until(() => expected.test(app.w.document.querySelector('[data-role="status"]').textContent), 'import complete: ' + app.w.document.querySelector('[data-role="status"]').textContent);
}

test('导入数组会去重、去掉 AI 后缀并按官方答案优先合并', async () => {
  const existing = { '9:2612': record({ answer: 'A', answer_source: 'ai', question: '以下哪些是正确选项？' }) };
  const app = createApp(existing);
  try {
    await until(() => app.w.document.querySelector('[data-role="exams"] input') && !app.w.document.querySelector('[data-role="refresh"]').disabled, 'initial refresh');
    await importPayload(app, [
      record({ question_id: 1, answer: 'A', answer_source: 'ai', question: '以下哪些是正确选项？（AI作答）' }),
      record({ question_id: 2, answer: 'B', answer_source: 'official' }),
      record({ question_id: 3, answer: null, answer_source: 'unresolved' }),
      record({ question_id: 4, question: '另一道题', answer: 'C', answer_source: 'official' })
    ]);
    const merged = JSON.parse(app.w.localStorage.getItem('exam-autofill:vault'));
    assert.equal(Object.keys(merged).length, 2);
    const first = Object.values(merged).find((item) => item.question === '以下哪些是正确选项？');
    assert.equal(first.answer, 'B');
    assert.equal(first.answer_source, 'official');
    assert.equal(Object.values(merged).filter((item) => item.question === '以下哪些是正确选项？').length, 1);
    assert.match(app.w.document.querySelector('[data-role="status"]').textContent, /去重 2 条/);
  } finally {
    app.close();
  }
});

test('导入旧版题库对象可用，非法数据不会覆盖原题库', async () => {
  const original = { '9:2612': record({ answer: 'A' }) };
  const app = createApp(original);
  try {
    await until(() => app.w.document.querySelector('[data-role="exams"] input') && !app.w.document.querySelector('[data-role="refresh"]').disabled, 'initial refresh');
    await importPayload(app, { '9:2612': record({ question_id: 88, answer: 'A' }) });
    const imported = JSON.parse(app.w.localStorage.getItem('exam-autofill:vault'));
    assert.equal(Object.keys(imported).length, 1);
    assert.equal(Object.values(imported)[0].question_id, 2612);
    const beforeInvalid = app.w.localStorage.getItem('exam-autofill:vault');
    await importPayload(app, [record({ question_id: 99 }), { exam_id: 9, question_id: 100, type: 2, question: '缺选项' }], /第 2 条题目无效/);
    assert.equal(app.w.localStorage.getItem('exam-autofill:vault'), beforeInvalid);
    assert.match(app.w.document.querySelector('[data-role="status"]').textContent, /第 2 条题目无效/);
  } finally {
    app.close();
  }
});

test('导出菜单支持点击、方向键、Escape 和外部点击', async () => {
  const app = createApp();
  try {
    await until(() => app.w.document.querySelector('[data-role="exams"] input') && !app.w.document.querySelector('[data-role="refresh"]').disabled, 'initial refresh');
    const button = app.w.document.querySelector('[data-role="export-menu-button"]');
    const menu = app.w.document.querySelector('[data-role="export-menu"]');
    button.click();
    assert.equal(menu.hidden, false);
    assert.equal(app.w.document.activeElement.getAttribute('role'), 'menuitem');
    app.w.document.activeElement.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(menu.hidden, true);
    assert.equal(app.w.document.activeElement, button);
    button.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(menu.hidden, false);
    app.w.document.body.dispatchEvent(new app.w.MouseEvent('click', { bubbles: true }));
    assert.equal(menu.hidden, true);
    app.w.localStorage.setItem('exam-autofill:vault', JSON.stringify({ '9:2612': record() }));
    const downloads = [];
    app.w.URL.createObjectURL = () => 'blob:fixture';
    app.w.URL.revokeObjectURL = () => undefined;
    app.w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
    for (const format of ['json', 'md']) {
      button.click();
      app.w.document.querySelector('[data-role="export-' + format + '"]').click();
      await tick();
      assert.equal(menu.hidden, true);
      assert(downloads.at(-1).endsWith('.' + format));
    }
    assert.equal(downloads.length, 2);
  } finally {
    app.close();
  }
});

test('同源答案冲突和超大文件都会拒绝且保持原题库', async () => {
  const original = { '9:2612': record({ answer: 'A' }) };
  const app = createApp(original);
  try {
    await until(() => app.w.document.querySelector('[data-role="exams"] input') && !app.w.document.querySelector('[data-role="refresh"]').disabled, 'initial refresh');
    const before = app.w.localStorage.getItem('exam-autofill:vault');
    await importPayload(app, [record({ question_id: 1, answer: 'A' }), record({ question_id: 2, answer: 'B' })], /合并失败/);
    assert.equal(app.w.localStorage.getItem('exam-autofill:vault'), before);
    await importPayload(app, [record({ question_id: 3 })], /超过 16 MB/, 16 * 1024 * 1024 + 1);
    assert.equal(app.w.localStorage.getItem('exam-autofill:vault'), before);
  } finally {
    app.close();
  }
});

test('完全相同且包含重复选项文字的题目可重复导入，数量保持不变', async () => {
  const app = createApp();
  const duplicatedOptions = record({ options: [{ key: 'A', text: '相同文字' }, { key: 'B', text: '相同文字' }, { key: 'C', text: '其他文字' }], answer: 'B' });
  try {
    await until(() => app.w.document.querySelector('[data-role="exams"] input') && !app.w.document.querySelector('[data-role="refresh"]').disabled, 'initial refresh');
    await importPayload(app, [duplicatedOptions], /题库导入完成/);
    const before = app.w.localStorage.getItem('exam-autofill:vault');
    await importPayload(app, [duplicatedOptions], /题库导入完成/);
    assert.equal(app.w.localStorage.getItem('exam-autofill:vault'), before);
    assert.equal(Object.keys(JSON.parse(before)).length, 1);
    assert.match(app.w.document.querySelector('[data-role="status"]').textContent, /新增 0，合并已有 1/);
  } finally { app.close(); }
});

test('损坏的JSON不会修改已有题库', async () => {
  const app = createApp({ '9:2612': record() });
  try {
    await until(() => app.w.document.querySelector('[data-role="exams"] input') && !app.w.document.querySelector('[data-role="refresh"]').disabled, 'initial refresh');
    const before = app.w.localStorage.getItem('exam-autofill:vault');
    const input = app.w.document.querySelector('[data-role="import-file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'invalid.json', size: 8, text: async () => '{broken' }] });
    input.dispatchEvent(new app.w.Event('change', { bubbles: true }));
    await until(() => /不是有效 JSON/.test(app.w.document.querySelector('[data-role="status"]').textContent), 'invalid JSON');
    assert.equal(app.w.localStorage.getItem('exam-autofill:vault'), before);
  } finally { app.close(); }
});
