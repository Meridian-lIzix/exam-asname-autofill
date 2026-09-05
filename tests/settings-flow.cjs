const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const project = process.argv[2] || require('node:path').resolve(__dirname, '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function run(granted, settingsProtocol = 2, sourceError = false) {
  const dom = new JSDOM(fs.readFileSync(project + '/options.html', 'utf8'), { url: 'chrome-extension://extension-id/options.html?embedded=1', runScripts: 'outside-only' });
  const w = dom.window;
  const requests = [];
  const messages = [];
  let opened = 0;
  const config = { baseUrl: 'https://fixture.example/v1', apiKey: 'fixture-only-key', model: 'fixture-model', enabled: true };
  w.chrome = {
    runtime: { openOptionsPage: async () => { opened++; }, sendMessage: async message => {
      messages.push(message);
      if (sourceError) return { ok: false, settingsProtocol, error: 'AI 设置页身份校验失败，请重新加载扩展并刷新网页；设置不受考试时间限制' };
      return { ok: true, settingsProtocol, data: message.type === 'getSettings' ? { settings: config } : message.type === 'testConnection' ? { tested: true, model: 'fixture-model', elapsedMs: 123 } : { saved: true } };
    } },
    permissions: { request: async permission => { requests.push(permission); return granted; } }
  };
  try {
    w.eval(fs.readFileSync(project + '/ai-client.js', 'utf8'));
    w.eval(fs.readFileSync(project + '/options.js', 'utf8'));
    await tick();
    assert(w.document.documentElement.classList.contains('embedded'));
    if (sourceError) {
      assert.match(w.document.getElementById('status').textContent, /身份校验失败/);
      assert.equal(w.document.getElementById('open-settings').hidden, false);
      w.document.getElementById('open-settings').click();
      await tick();
      assert.equal(opened, 1);
      assert.equal(w.document.getElementById('api-key').value, '');
      return;
    }
    if (settingsProtocol !== 2) {
      assert.match(w.document.getElementById('status').textContent, /后台仍是旧版本/);
      assert.equal(w.document.getElementById('api-key').value, '');
      assert.equal(messages.length, 1);
      return;
    }
    assert.equal(w.document.getElementById('api-key').type, 'password');
    assert.equal(w.document.getElementById('api-key').value, config.apiKey);
    w.document.getElementById('settings').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(requests[0].origins[0], 'https://fixture.example/*');
    assert.equal(messages.filter(message => message.type === 'saveSettings').length, granted ? 1 : 0);
    assert.equal(w.document.getElementById('status').dataset.error, String(!granted));
    assert.equal(w.document.getElementById('save').disabled, false);
    assert(!w.document.getElementById('status').textContent.includes(config.apiKey));
    w.document.getElementById('test-ai').click();
    await tick();
    assert.equal(messages.filter(message => message.type === 'testConnection').length, granted ? 1 : 0);
    assert.equal(w.document.getElementById('status').dataset.error, String(!granted));
    if (granted) assert.match(w.document.getElementById('status').textContent, /连接测试成功.+123 ms/);
    w.document.getElementById('model').value = 'unsaved-model';
    w.document.getElementById('test-ai').click();
    await tick();
    assert.match(w.document.getElementById('status').textContent, /未保存修改/);
    assert.equal(messages.filter(message => message.type === 'testConnection').length, granted ? 1 : 0);
  } finally { w.close(); }
}
(async () => {
  await run(true);
  await run(false);
  await run(true, 1);
  await run(true, 2, true);
  process.stdout.write('PASS: 嵌入式API设置回填、域名权限、保存、单题测试及未保存修改拦截\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
