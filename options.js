(() => {
  if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.classList.add('embedded');
  const field = (id) => document.getElementById(id);
  let savedSettings = null;
  const status = (text, error = false) => {
    field('status').textContent = text;
    field('status').dataset.error = String(error);
    field('open-settings').hidden = !error || !/身份校验|扩展设置或考试页面/.test(text);
  };
  const send = async (type, data = {}) => {
    const result = await chrome.runtime.sendMessage({ channel: 'exam-autofill', type, ...data });
    if (result && result.settingsProtocol !== 2) throw new Error('扩展后台仍是旧版本，请在扩展管理页重新加载扩展，再刷新考试网页');
    if (!result?.ok) throw new Error(result?.error || '扩展后台未响应，请重新加载扩展');
    return result.data;
  };
  const formSettings = () => EAFAI.normalizeConfig({ baseUrl: field('base-url').value, apiKey: field('api-key').value, model: field('model').value, enabled: field('enabled').checked });
  const sameSettings = (left, right) => Boolean(left && right) && left.baseUrl === right.baseUrl && left.apiKey === right.apiKey && left.model === right.model && left.enabled === right.enabled;
  async function load() {
    const { settings } = await send('getSettings');
    if (!settings) return;
    savedSettings = EAFAI.normalizeConfig(settings);
    field('base-url').value = savedSettings.baseUrl;
    field('api-key').value = savedSettings.apiKey;
    field('model').value = savedSettings.model;
    field('enabled').checked = savedSettings.enabled;
  }
  field('settings').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const settings = formSettings();
      field('save').disabled = true;
      field('test-ai').disabled = true;
      status('正在保存…');
      if (settings.enabled && !await chrome.permissions.request({ origins: [EAFAI.permissionOrigin(settings)] })) throw new Error('未授权访问 AI 服务，设置未保存');
      await send('saveSettings', { settings });
      savedSettings = settings;
      status(settings.enabled ? '已保存并启用 AI，可以开始答题。' : '已保存，AI 补答已关闭。');
      if (window.parent !== window) window.parent.postMessage({ channel: 'exam-autofill-settings-saved' }, 'https://exam.asname.cn');
    } catch (error) {
      status(error.message, true);
    } finally {
      field('save').disabled = false;
      field('test-ai').disabled = false;
    }
  });
  field('test-ai').addEventListener('click', async () => {
    try {
      const settings = formSettings();
      if (!savedSettings) throw new Error('尚未成功保存 AI 配置，请先点击“保存设置”并确认保存成功');
      if (!sameSettings(settings, savedSettings)) throw new Error('当前表单有未保存修改，请先点击“保存设置”，再测试 AI');
      field('save').disabled = true;
      field('test-ai').disabled = true;
      status(`正在测试模型“${settings.model}”…`);
      if (!await chrome.permissions.request({ origins: [EAFAI.permissionOrigin(settings)] })) throw new Error('未授权访问 AI 服务，未开始测试');
      const result = await send('testConnection');
      const elapsed = Number.isFinite(result?.elapsedMs) ? Math.max(0, Math.round(result.elapsedMs)) : 0;
      status(`连接测试成功：模型“${result?.model || settings.model}”返回示例题答案 B=2，耗时 ${elapsed} ms。这里只验证接口和答案格式。`);
    } catch (error) {
      status(error.message, true);
    } finally {
      field('save').disabled = false;
      field('test-ai').disabled = false;
    }
  });
  field('open-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage().catch((error) => status('无法打开设置页：' + error.message, true));
  });
  load().catch((error) => status(error.message, true));
})();
