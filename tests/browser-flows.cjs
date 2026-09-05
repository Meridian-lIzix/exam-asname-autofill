const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const project = process.argv[2] || path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8'));
const contentScripts = [...new Set(manifest.content_scripts.flatMap(script => script.js || []))];
const source = Object.fromEntries(contentScripts.map(name => [name, fs.readFileSync(path.join(project, name), 'utf8')]));
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check, label) {
  for (let index = 0; index < 1000; index++) {
    if (check()) return;
    await tick();
  }
  throw new Error('Timeout: ' + label);
}
function createApp({ aiEnabled = true, failWrite = false, practice = false, delaySite = 0, settings = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://exam.asname.cn/theory', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const now = Math.floor(Date.now() / 1000);
  const name = practice ? '知识练习A' : '每周测试5（9/5）';
  let rows = [
    { exam_id: 18, exam_name: name, type: 2, is_end: 0, s_time: now - 10, e_time: now + 3600, now_time: now },
    { exam_id: 1, exam_name: '知识练习A（已过期）', type: 2, is_end: 0, s_time: now - 7200, e_time: now - 3600, now_time: now },
    { exam_id: 2, exam_name: '每周测试（已交卷）', type: 2, is_end: 2, s_time: now - 10, e_time: now + 3600, now_time: now },
    { exam_id: 3, exam_name: '未来测试', type: 2, is_end: 0, s_time: now + 60, e_time: now + 3600, now_time: now }
  ];
  const ids = Array.from({ length: practice ? 4 : 65 }, (_, index) => index + 1);
  const submitted = new Map();
  const writes = [];
  const groups = [];
  const siteRequests = [];
  let aiActive = 0;
  let peak = 0;
  const allTimers = [];
  const originalSetInterval = w.setInterval.bind(w);
  w.setInterval = (fn, delay) => { const id = originalSetInterval(fn, delay); allTimers.push(id); return id; };
  Object.defineProperty(w.navigator, 'locks', { value: { request: async (_, options, worker) => worker({ name: 'test-lock' }) } });
  w.localStorage.setItem('exam-autofill:settings', JSON.stringify(settings));
  w.sessionStorage.setItem('login-fixture', 'eyJ.fixture.value');
  const runtimeStates = [];
  w.chrome = { runtime: { getURL: file => 'chrome-extension://extension-id/' + file, sendMessage: async message => {
    if (message.type === 'getStatus') return { ok: true, data: { enabled: aiEnabled, model: 'fixture-model' } };
    if (message.type === 'cancelRun') return { ok: true, data: { stopped: true } };
    if (message.type === 'solveBatch') {
      runtimeStates.push({ batchSize: message.batchSettings?.batchSize, concurrency: message.batchSettings?.concurrency, batchDisabled: w.document.querySelector('[data-role="ai-batch-size"]').disabled, concurrencyDisabled: w.document.querySelector('[data-role="ai-concurrency"]').disabled });
      peak = Math.max(peak, ++aiActive);
      groups.push(message.questions.length);
      await new Promise(resolve => setTimeout(resolve, groups.length === 1 ? 25 : 5));
      aiActive--;
      return { ok: true, data: { model: 'fixture-model', errors: [], answers: message.questions.map(q => ({ question_id: q.question_id, answers: ['B'] })).reverse() } };
    }
    throw new Error('Unexpected message ' + message.type);
  } } };
  w.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(raw) {
      siteRequests.push(this.url);
      Promise.resolve().then(async () => {
        if (delaySite) await new Promise(resolve => setTimeout(resolve, delaySite));
        const body = raw ? JSON.parse(raw) : null;
        let data;
        if (this.url.startsWith('/api/homepage/indexdata')) data = rows;
        else if (this.url.startsWith('/api/assessment/getassessmentids')) data = ids.map(id => ({ id }));
        else if (body?.act === 'add') {
          writes.push({ ...body });
          if (!(failWrite && body.question_id === 5)) submitted.set(body.question_id, body.answer);
          data = {};
        } else if (body?.act === 'select') {
          const current = submitted.get(body.question_id) || '';
          data = { id: body.question_id, type: 1, name: '集成验证题目 ' + body.question_id, options: '[{"A":"甲"},{"B":"乙"},{"C":"丙"}]', score: 1, answer: current, r_answer: practice && current ? 'B' : '' };
        } else throw new Error('Unexpected request ' + this.url);
        this.status = 200;
        this.responseText = JSON.stringify({ code: 1, data });
        this.onload();
      }).catch(error => { this.status = 500; this.responseText = JSON.stringify({ code: 0, msg: error.message }); this.onload(); });
    }
  };
  for (const name of contentScripts) w.eval(source[name]);
  return { dom, w, rows, setRows: value => { rows = value; }, submitted, writes, groups, siteRequests, runtimeStates, getPeak: () => peak, close: () => { for (const id of allTimers) w.clearInterval(id); w.close(); } };
}
async function start(app) {
  await until(() => app.w.document.querySelector('[data-role="exams"] input'), 'exam discovery');
  await until(() => !app.w.document.querySelector('[data-role="refresh"]').disabled, 'refresh complete');
  const checkboxes = app.w.document.querySelectorAll('[data-role="exams"] input');
  assert.equal(checkboxes.length, 1);
  assert.equal(checkboxes[0].value, '18');
  checkboxes[0].checked = true;
  checkboxes[0].dispatchEvent(new app.w.Event('change', { bubbles: true }));
  app.w.document.querySelector('[data-role="start"]').click();
  await tick();
  await until(() => app.w.document.querySelector('[data-role="status"]').textContent.startsWith('处理结束'), 'run complete: ' + app.w.document.querySelector('[data-role="status"]').textContent);
}
(async () => {
  const app = createApp();
  try {
    assert.equal(app.w.document.querySelector('[data-role="ai-batch-size"]').value, '30');
    assert.equal(app.w.document.querySelector('[data-role="ai-concurrency"]').value, '2');
    await start(app);
    assert.deepEqual(app.groups.sort((a, b) => a - b), [5, 30, 30]);
    assert.equal(app.getPeak(), 2);
    assert(app.runtimeStates.every(state => state.batchSize === 30 && state.concurrency === 2 && state.batchDisabled && state.concurrencyDisabled));
    assert.equal(app.w.document.querySelector('[data-role="ai-batch-size"]').disabled, false);
    assert.equal(app.w.document.querySelector('[data-role="ai-concurrency"]').disabled, false);
    assert.equal(app.submitted.size, 65);
    assert(app.writes.every(item => item.answer === 'B'));
    const vault = JSON.parse(app.w.localStorage.getItem('exam-autofill:vault'));
    assert.equal(Object.keys(vault).length, 65);
    assert(Object.values(vault).every(item => item.answer_source === 'ai' && item.submission_status === 'verified'));
    await start(app);
    assert.equal(app.groups.length, 3);
    assert.equal(app.writes.length, 65);
    assert.match(app.w.document.querySelector('[data-role="status"]').textContent, /题库命中 65，AI 0/);
    app.setRows([]);
    app.w.document.querySelector('[data-role="refresh"]').click();
    await until(() => app.w.document.querySelector('[data-role="exams"]').textContent.includes('没有识别到'), 'empty list');
    assert.equal(app.w.document.querySelectorAll('[data-role="exams"] input').length, 0);
    process.stdout.write('PASS: 65题自动场次、30/30/5分组、并发2、乱序映射、落库、重复运行和场次移除\n');
  } finally { app.close(); }
  const failed = createApp({ failWrite: true });
  try {
    await start(failed);
    const vault = JSON.parse(failed.w.localStorage.getItem('exam-autofill:vault'));
    assert.equal(vault['18:5'].submission_status, 'unverified');
    assert.equal(vault['18:5'].answer_source, 'ai');
    assert(failed.w.document.querySelector('[data-role="status"]').textContent.includes('作答已核验 64'));
    process.stdout.write('PASS: 网站假成功保留AI答案，作答明确待核验\n');
  } finally { failed.close(); }
  const offline = createApp({ aiEnabled: false });
  try {
    await start(offline);
    assert.equal(offline.groups.length, 0);
    assert.equal(offline.writes.length, 0);
    const vault = JSON.parse(offline.w.localStorage.getItem('exam-autofill:vault'));
    assert.equal(Object.keys(vault).length, 65);
    assert(Object.values(vault).every(item => item.answer === null));
    process.stdout.write('PASS: 未启用AI时只收题，无AI调用和试答\n');
  } finally { offline.close(); }
  const practice = createApp({ aiEnabled: false, practice: true });
  try {
    await start(practice);
    assert.equal(practice.submitted.size, 4);
    assert.equal(practice.groups.length, 0);
    assert([...practice.submitted.values()].every(value => value === 'B'));
    const vault = JSON.parse(practice.w.localStorage.getItem('exam-autofill:vault'));
    assert(Object.values(vault).every(item => item.answer_source === 'official' && item.submission_status === 'verified'));
    assert.match(practice.w.document.querySelector('[data-role="status"]').textContent, /网站答案 4，题库命中 0，AI 0/);
    await start(practice);
    assert.match(practice.w.document.querySelector('[data-role="status"]').textContent, /网站答案 4，题库命中 0，AI 0/);
    process.stdout.write('PASS: 原知识练习探测、官方答案校正流程\n');
  } finally { practice.close(); }
  const settings = createApp({ settings: { examIds: [18], concurrency: 5 } });
  let savedSettings;
  try {
    await until(() => settings.w.document.querySelector('[data-role="exams"] input') && !settings.w.document.querySelector('[data-role="refresh"]').disabled, 'settings ready');
    const batchSize = settings.w.document.querySelector('[data-role="ai-batch-size"]');
    const aiConcurrency = settings.w.document.querySelector('[data-role="ai-concurrency"]');
    assert.equal(batchSize.value, '30');
    assert.equal(aiConcurrency.value, '2');
    batchSize.value = '20';
    batchSize.dispatchEvent(new settings.w.Event('input', { bubbles: true }));
    aiConcurrency.value = '3';
    aiConcurrency.dispatchEvent(new settings.w.Event('input', { bubbles: true }));
    await tick();
    savedSettings = JSON.parse(settings.w.localStorage.getItem('exam-autofill:settings'));
    assert.equal(savedSettings.aiBatchSize, 20);
    assert.equal(savedSettings.aiConcurrency, 3);
    settings.w.document.querySelector('[data-role="refresh"]').click();
    await tick();
    await until(() => !settings.w.document.querySelector('[data-role="refresh"]').disabled, 'settings refresh');
    assert.equal(batchSize.value, '20');
    assert.equal(aiConcurrency.value, '3');
    process.stdout.write('PASS: AI 分组设置输入自动保存、刷新保持并兼容旧设置默认值\n');
  } finally { settings.close(); }
  const restored = createApp({ settings: savedSettings });
  try {
    await until(() => restored.w.document.querySelector('[data-role="exams"] input') && !restored.w.document.querySelector('[data-role="refresh"]').disabled, 'settings restore');
    assert.equal(restored.w.document.querySelector('[data-role="ai-batch-size"]').value, '20');
    assert.equal(restored.w.document.querySelector('[data-role="ai-concurrency"]').value, '3');
  } finally { restored.close(); }
  const invalid = createApp({ settings: { examIds: [18] } });
  try {
    await until(() => invalid.w.document.querySelector('[data-role="exams"] input') && !invalid.w.document.querySelector('[data-role="refresh"]').disabled, 'invalid settings ready');
    const batchSize = invalid.w.document.querySelector('[data-role="ai-batch-size"]');
    const aiConcurrency = invalid.w.document.querySelector('[data-role="ai-concurrency"]');
    batchSize.value = '101';
    batchSize.dispatchEvent(new invalid.w.Event('input', { bubbles: true }));
    invalid.w.document.querySelector('[data-role="start"]').click();
    await tick();
    assert.equal(invalid.groups.length, 0);
    assert.match(invalid.w.document.querySelector('[data-role="status"]').textContent, /每组题数必须/);
    batchSize.value = '30';
    batchSize.dispatchEvent(new invalid.w.Event('input', { bubbles: true }));
    aiConcurrency.value = '11';
    aiConcurrency.dispatchEvent(new invalid.w.Event('input', { bubbles: true }));
    invalid.w.document.querySelector('[data-role="start"]').click();
    await tick();
    assert.equal(invalid.groups.length, 0);
    assert.match(invalid.w.document.querySelector('[data-role="status"]').textContent, /AI 并发组数必须/);
    const help = invalid.w.document.querySelector('[data-role="ai-help"]');
    const tooltip = invalid.w.document.querySelector('[data-role="ai-tooltip"]');
    help.dispatchEvent(new invalid.w.MouseEvent('mouseenter'));
    assert.equal(tooltip.hidden, false);
    help.dispatchEvent(new invalid.w.MouseEvent('mouseleave'));
    tooltip.dispatchEvent(new invalid.w.MouseEvent('mouseenter'));
    assert.equal(tooltip.hidden, false);
    tooltip.dispatchEvent(new invalid.w.MouseEvent('mouseleave'));
    help.focus();
    assert.equal(tooltip.hidden, false);
    invalid.w.document.dispatchEvent(new invalid.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(tooltip.hidden, true);
    const panelCss = fs.readFileSync(path.join(project, 'panel.css'), 'utf8');
    assert.match(panelCss, /\.eaf-export-menu[\s\S]*left:\s*50%/);
    assert.match(panelCss, /\.eaf-export-menu[\s\S]*transform:\s*translateX\(-50%\)/);
    process.stdout.write('PASS: 非法 AI 设置不调用 AI，tooltip 支持悬停、聚焦和 Escape，导出菜单居中\n');
  } finally { invalid.close(); }
  const custom = createApp({ settings: { examIds: [18], aiBatchSize: 20, aiConcurrency: 3 } });
  try {
    await start(custom);
    assert.deepEqual(custom.groups.sort((a, b) => a - b), [5, 20, 20, 20]);
    assert.equal(custom.getPeak(), 3);
    assert(custom.runtimeStates.every(state => state.batchSize === 20 && state.concurrency === 3 && state.batchDisabled && state.concurrencyDisabled));
    assert.equal(custom.w.document.querySelector('[data-role="ai-batch-size"]').disabled, false);
    assert.equal(custom.w.document.querySelector('[data-role="ai-concurrency"]').disabled, false);
    process.stdout.write('PASS: 自定义 20/3 分组实际为 20/20/20/5，峰值并发 3，运行中输入禁用\n');
  } finally { custom.close(); }
  const capture = createApp();
  try {
    await until(() => capture.w.document.querySelector('[data-role="exams"] input'), 'capture discovery');
    await until(() => !capture.w.document.querySelector('[data-role="refresh"]').disabled, 'capture ready');
    capture.w.localStorage.setItem('exam_id', '18');
    const downloads = [];
    capture.w.URL.createObjectURL = () => 'blob:fixture';
    capture.w.URL.revokeObjectURL = () => undefined;
    capture.w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
    capture.w.document.querySelector('[data-role="capture"]').click();
    await until(() => downloads.length === 1, 'capture download');
    const snapshot = JSON.parse(capture.w.localStorage.getItem('exam-autofill:capture:18'));
    assert.equal(snapshot.questions.length, 65);
    assert.equal(snapshot.question_ids.length, 65);
    assert.equal(snapshot.errors.length, 0);
    assert.equal(snapshot.exam_id, 18);
    assert.equal(capture.writes.length, 0);
    assert.equal(capture.groups.length, 0);
    assert(!JSON.stringify(snapshot).includes('eyJ'));
    assert.match(downloads[0], /^场次采集-18-\d+\.json$/);
    const button = capture.w.document.querySelector('[data-role="ai-settings"]');
    const frame = capture.w.document.querySelector('[data-role="ai-frame"]');
    button.click();
    await tick();
    assert.equal(frame.hidden, false);
    assert.equal(frame.src, 'chrome-extension://extension-id/options.html?embedded=1');
    assert.equal(capture.w.document.querySelector('input[type="password"]'), null);
    button.click();
    await tick();
    assert.equal(frame.hidden, true);
    process.stdout.write('PASS: 当前场次65题只读采集导出、无答题或AI调用、面板内独立设置页开关\n');
  } finally { capture.close(); }
  const stopping = createApp({ delaySite: 5 });
  try {
    await until(() => stopping.w.document.querySelector('[data-role="exams"] input'), 'stop discovery');
    await until(() => !stopping.w.document.querySelector('[data-role="refresh"]').disabled, 'stop ready');
    stopping.w.document.querySelector('[data-role="exams"] input').checked = true;
    stopping.w.document.querySelector('[data-role="start"]').click();
    await until(() => stopping.writes.length > 0, 'submissions start');
    stopping.w.document.querySelector('[data-role="stop"]').click();
    await tick();
    const countAtStop = stopping.siteRequests.length;
    await until(() => !stopping.w.document.querySelector('[data-role="start"]').disabled, 'stop complete');
    assert.equal(stopping.siteRequests.length, countAtStop);
    process.stdout.write('PASS: 停止后取消排队中的网站请求，不再派发读取或提交\n');
  } finally { stopping.close(); }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
