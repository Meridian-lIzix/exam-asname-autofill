(() => {
  if (document.getElementById('exam-autofill-panel')) return;
  const core = EAFCore;
  const engine = EAFEngine;
  const VAULT_KEY = 'exam-autofill:vault';
  const SETTINGS_KEY = 'exam-autofill:settings';
  const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
  const INDEX_API = '/api/homepage/indexdata';
  const ASSESSMENT_API = '/api/assessment/assessmentmain';
  let running = false;
  let stopped = false;
  let runId = '';
  let refreshing = false;
  let currentExams = [];
  let siteLimit = 5;
  let siteActive = 0;
  const siteWaiters = [];
  let importing = false;

  const panel = document.createElement('div');
  panel.id = 'exam-autofill-panel';
  panel.innerHTML = [
    '<header><span>批量答题助手 <small>2.0.2</small></span><button type="button" data-role="toggle" aria-label="收起面板" aria-expanded="true">—</button></header>',
    '<section data-role="body">',
    '<div class="eaf-actions"><button type="button" data-role="refresh">刷新场次</button><button type="button" data-role="ai-settings" aria-expanded="false">AI 设置</button></div>',
    '<iframe data-role="ai-frame" title="AI 服务配置" hidden></iframe>',
    '<div class="eaf-actions"><button type="button" data-role="capture">仅采集当前场次题目</button></div>',
    '<div class="eaf-exams" data-role="exams" aria-label="当前可作答场次">正在读取场次…</div>',
    '<label class="eaf-field">网页并发<input type="number" data-role="concurrency" min="1" max="20" step="1" value="5"></label>',
    '<div class="eaf-ai-controls"><span>AI：</span><label class="eaf-field"><input type="number" data-role="ai-batch-size" aria-label="AI 每组题数" min="1" max="100" step="1" value="30" required>题/组</label><span aria-hidden="true">·</span><label class="eaf-field">并发<input type="number" data-role="ai-concurrency" aria-label="AI 并发组数" min="1" max="10" step="1" value="2" required></label><button type="button" class="eaf-info" data-role="ai-help" aria-label="AI 分组与并发说明" aria-describedby="exam-autofill-ai-help">i</button><div class="eaf-tooltip" id="exam-autofill-ai-help" data-role="ai-tooltip" role="tooltip" hidden><p>题/组：每次 AI 请求包含的题目数（1～100）。建议 30 题；题目较长或返回不完整时调低。</p><p>并发：同时请求 AI 的组数（1～10）。建议 2 组；服务限流时调低。</p><p>最多同时处理题数＝每组题数 × 并发组数。题目较多时会自动分批，完成一组后继续下一组。</p><p>与网页并发独立，修改后自动保存。</p></div></div>',
    '<div class="eaf-status" data-role="ai-status">正在读取 AI 配置…</div>',
    '<div class="eaf-actions"><button type="button" data-role="start">开始</button><button type="button" data-role="stop" disabled>停止</button></div>',
    '<div class="eaf-status" data-role="status" role="status" aria-live="polite">待命</div>',
    '<div class="eaf-bar" data-role="progress" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-role="bar"></i></div>',
    '<div class="eaf-stats" data-role="stats"></div>',
    '<div class="eaf-actions eaf-vault-actions"><button type="button" data-role="import">导入题库</button><div class="eaf-export-wrap"><button type="button" data-role="export-menu-button" aria-haspopup="menu" aria-controls="exam-autofill-export-menu" aria-expanded="false">导出题库</button><div class="eaf-export-menu" id="exam-autofill-export-menu" data-role="export-menu" role="menu" hidden><button type="button" role="menuitem" data-role="export-md">导出 Markdown</button><button type="button" role="menuitem" data-role="export-json">导出 JSON</button></div></div><button type="button" data-role="clear">清空题库</button><input class="eaf-file-input" type="file" data-role="import-file" accept="application/json,.json" aria-label="选择题库 JSON 文件"></div>',
    '<div class="eaf-log" data-role="log" aria-label="处理日志"></div>',
    '</section>'
  ].join('');
  document.body.appendChild(panel);
  const el = (role) => panel.querySelector('[data-role="' + role + '"]');
  const setStatus = (text) => { el('status').textContent = text; };
  const shouldStop = () => stopped;
  const selectedIds = () => [...el('exams').querySelectorAll('input:checked')].map((item) => Number(item.value));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function readBatchSettings() {
    for (const role of ['ai-batch-size', 'ai-concurrency']) {
      const input = el(role);
      input.setAttribute('aria-invalid', String(!input.checkValidity()));
      if (!input.checkValidity()) {
        input.reportValidity();
        throw new Error(input.getAttribute('aria-label') + '必须为 ' + input.min + '～' + input.max + ' 的整数');
      }
    }
    return engine.normalizeBatchSettings({ batchSize: Number(el('ai-batch-size').value), concurrency: Number(el('ai-concurrency').value) });
  }

  function saveBatchSettings() {
    const batchSettings = readBatchSettings();
    storeObject(SETTINGS_KEY, { ...storedObject(SETTINGS_KEY), aiBatchSize: batchSettings.batchSize, aiConcurrency: batchSettings.concurrency });
    return batchSettings;
  }

  function renderAIStatus(status) {
    el('ai-status').textContent = status.enabled ? '模型：' + status.model : 'AI 未启用（题库仍可使用）';
  }

  function log(message, level = 'info') {
    const line = document.createElement('div');
    line.className = 'eaf-log-' + level;
    line.textContent = new Date().toLocaleTimeString('zh-CN') + ' ' + message;
    el('log').prepend(line);
    while (el('log').childElementCount > 150) el('log').lastElementChild.remove();
  }

  function setBar(value) {
    const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
    el('bar').style.transform = 'scaleX(' + percent / 100 + ')';
    el('progress').setAttribute('aria-valuenow', String(percent));
  }

  function storedObject(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    let value;
    try { value = JSON.parse(raw); } catch (error) { throw new Error('本地数据格式损坏：' + key, { cause: error }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地数据结构无效：' + key);
    return Object.assign(Object.create(null), value);
  }

  function storeObject(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (error) { throw new Error('本地保存失败，请先导出题库并检查浏览器存储空间', { cause: error }); }
  }

  function loadVault() {
    const vault = storedObject(VAULT_KEY);
    for (const [key, record] of Object.entries(vault)) {
      try { vault[key] = core.mergeRecord(null, { ...record, type: Number(record.type) }); }
      catch (error) { throw new Error('题库记录 ' + key + ' 无效：' + error.message, { cause: error }); }
    }
    return vault;
  }

  function uniqueRecords(vault) {
    const byContent = new Map();
    for (const record of Object.values(vault)) {
      const key = core.fingerprint(record);
      byContent.set(key, core.mergeRecord(byContent.get(key), record));
    }
    return [...byContent.values()];
  }

  function refreshStats(vault = loadVault()) {
    el('stats').textContent = '本地题库：' + new Set(Object.values(vault).map((record) => core.fingerprint(record))).size + ' 题';
  }

  function createVaultWriter(vault) {
    const index = new Map();
    const rebuild = () => {
      index.clear();
      for (const record of Object.values(vault)) {
        const fingerprint = core.fingerprint(record);
        if (!index.has(fingerprint)) index.set(fingerprint, []);
        index.get(fingerprint).push(record);
      }
    };
    rebuild();
    const save = (record) => {
      const fingerprint = core.fingerprint(record);
      let key = Object.keys(vault).find((key) => {
        const old = vault[key];
        return String(old.exam_id) === String(record.exam_id) && String(old.question_id) === String(record.question_id) && core.fingerprint(old) === fingerprint;
      });
      if (!key) {
        const base = record.exam_id + ':' + record.question_id;
        key = base;
        let version = 1;
        while (Object.hasOwn(vault, key)) key = base + ':' + version++;
      }
      const previous = vault[key];
      const merged = core.mergeRecord(previous, { ...record, updated_at: new Date().toISOString() });
      const next = { ...vault, [key]: merged };
      storeObject(VAULT_KEY, next);
      vault[key] = merged;
      const matches = index.get(fingerprint) || [];
      index.set(fingerprint, matches.filter((item) => item !== previous).concat(merged));
      refreshStats(vault);
      return merged;
    };
    return { save, lookup: (record) => core.lookupAnswer(index.get(core.fingerprint(record)) || [], record) };
  }

  function readToken() {
    for (const key of Object.keys(sessionStorage)) {
      const raw = sessionStorage.getItem(key);
      if (typeof raw !== 'string') continue;
      if (raw.startsWith('eyJ')) return raw;
      if (!raw.startsWith('"eyJ')) continue;
      let value;
      try { value = JSON.parse(raw); } catch (error) { throw new Error('登录凭证格式错误，请刷新页面重新登录', { cause: error }); }
      if (typeof value === 'string' && value.startsWith('eyJ')) return value;
    }
    throw new Error('未找到登录凭证，请登录后刷新页面');
  }

  function sendRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.timeout = 20000;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Authorization', readToken());
      if (body) xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
      const fail = (message, retryable = false) => {
        const error = new Error(message);
        error.retryable = retryable;
        reject(error);
      };
      xhr.onerror = () => fail('网站网络请求失败', true);
      xhr.ontimeout = () => fail('网站请求超时', true);
      xhr.onabort = () => fail('网站请求已取消');
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return fail('网站请求失败（HTTP ' + xhr.status + '）', xhr.status === 429 || xhr.status >= 500);
        let payload;
        try { payload = JSON.parse(xhr.responseText); }
        catch (error) { return fail('网站返回非 JSON 内容，请检查登录状态'); }
        if (!payload || Number(payload.code) !== 1) return fail(payload?.msg || '网站拒绝请求');
        resolve(payload.data);
      };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  async function request(method, url, body) {
    if (siteActive >= siteLimit) await new Promise((resolve) => siteWaiters.push(resolve));
    else siteActive += 1;
    try {
      for (let attempt = 0; ; attempt++) {
        if (stopped && running) throw new Error('任务已停止，已取消排队的网站请求');
        try { return await sendRequest(method, url, body); }
        catch (error) {
          if (!error.retryable || attempt >= 2 || stopped && running) throw error;
          await sleep(500 * 2 ** attempt);
        }
      }
    } finally {
      const next = siteWaiters.shift();
      if (next) next();
      else siteActive -= 1;
    }
  }

  const api = {
    select: (examId, questionId) => request('POST', ASSESSMENT_API, { exam_id: examId, question_id: questionId, act: 'select' }),
    submit: (examId, questionId, answer) => request('POST', ASSESSMENT_API, { exam_id: examId, question_id: questionId, answer, act: 'add' })
  };

  async function extension(type, data = {}) {
    let response;
    try { response = await chrome.runtime.sendMessage({ channel: 'exam-autofill', type, ...data }); }
    catch (error) { throw new Error('扩展后台连接中断，请重新加载扩展并刷新网页', { cause: error }); }
    if (!response?.ok) throw new Error(response?.error || '扩展后台没有返回结果');
    return response.data;
  }

  async function fetchExams() {
    const rows = await request('GET', INDEX_API);
    if (!Array.isArray(rows)) throw new Error('场次接口没有返回列表');
    const parents = new Map(rows.filter((row) => row && Number(row.group_id) === Number(row.exam_id) && Number(row.group_id) > 0).map((row) => [Number(row.exam_id), row]));
    const allRows = rows.filter((row) => !parents.has(Number(row?.exam_id))).map((row) => ({ row, parent: parents.get(Number(row?.group_id)) }));
    for (const parent of parents.values()) {
      const now = Number(parent.now_time) || Date.now() / 1000;
      if (Number(parent.is_end) === 2 || !Number(parent.s_time) || !Number(parent.e_time) || now < Number(parent.s_time) || now > Number(parent.e_time)) continue;
      const children = await request('GET', INDEX_API + '?group_id=' + engine.positiveId(parent.exam_id));
      if (!Array.isArray(children)) throw new Error('分组场次接口没有返回列表');
      for (const row of children) allRows.push({ row, parent });
    }
    const exams = new Map();
    for (const { row, parent } of allRows) {
      try {
        const exam = engine.identifyExam(row, parent);
        if (exam) exams.set(exam.id, exam);
      } catch (error) {
        log('忽略无效场次：' + error.message, 'error');
      }
    }
    return [...exams.values()].sort((left, right) => left.start - right.start || left.id - right.id);
  }

  function renderExamList(exams, checked) {
    el('exams').replaceChildren();
    for (const exam of exams) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = String(exam.id);
      checkbox.checked = checked.has(exam.id);
      const text = document.createElement('span');
      text.textContent = exam.name + ' · ' + (exam.mode === 'practice' ? '练习' : '测试');
      label.append(checkbox, text);
      el('exams').appendChild(label);
    }
    if (!exams.length) el('exams').textContent = '当前没有识别到可作答场次';
    el('start').disabled = running || !exams.length;
  }

  async function refreshExams() {
    if (running || refreshing || importing) return;
    refreshing = true;
    el('refresh').disabled = true;
    el('exams').setAttribute('aria-busy', 'true');
    try {
      const settings = storedObject(SETTINGS_KEY);
      const checked = new Set(currentExams.length ? selectedIds() : Array.isArray(settings.examIds) ? settings.examIds.map(Number) : []);
      currentExams = await fetchExams();
      renderExamList(currentExams, checked);
      const visibleIds = currentExams.filter((exam) => checked.has(exam.id)).map((exam) => exam.id);
      storeObject(SETTINGS_KEY, { ...storedObject(SETTINGS_KEY), examIds: visibleIds });
      try {
        const status = await extension('getStatus');
        renderAIStatus(status);
      } catch (error) {
        el('ai-status').textContent = error.message;
        log('读取 AI 配置失败：' + error.message, 'error');
      }
    } catch (error) {
      currentExams = [];
      renderExamList([], new Set());
      el('exams').textContent = error.message;
      log('刷新场次失败：' + error.message, 'error');
    } finally {
      refreshing = false;
      el('refresh').disabled = false;
      el('exams').setAttribute('aria-busy', 'false');
    }
  }

  async function fetchQuestionIds(exam) {
    const rows = await request('GET', '/api/assessment/getassessmentids?exam_id=' + exam.id);
    if (!Array.isArray(rows)) throw new Error('题号接口没有返回列表');
    const ids = rows.map((row) => engine.positiveId(row?.id, '题目 ID'));
    if (new Set(ids).size !== ids.length) throw new Error('题号列表存在重复 ID');
    if (!ids.length) throw new Error('场次没有可读取的题目');
    return ids;
  }

  function setRunning(value) {
    running = value;
    if (value) closeExportMenu();
    for (const role of ['start', 'refresh', 'clear', 'concurrency', 'ai-batch-size', 'ai-concurrency', 'capture', 'import', 'import-file', 'export-menu-button']) el(role).disabled = value;
    el('stop').disabled = !value;
    if (!value) el('start').disabled = !currentExams.length;
  }

  async function runSelected() {
    if (running || refreshing || importing) return;
    const batchSettings = saveBatchSettings();
    const requestedIds = selectedIds();
    if (!requestedIds.length) return log('请先勾选场次', 'error');
    siteLimit = Math.max(1, Math.min(20, Math.trunc(Number(el('concurrency').value) || 5)));
    el('concurrency').value = String(siteLimit);
    stopped = false;
    runId = crypto.randomUUID();
    setRunning(true);
    setStatus('正在核实所选场次…');
    setBar(0);
    try {
      await navigator.locks.request('exam-autofill-run', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('另一个考试页面正在运行，请先停止该页面的任务');
        const exams = (await fetchExams()).filter((exam) => requestedIds.includes(exam.id));
        currentExams = exams;
        renderExamList(exams, new Set(requestedIds));
        if (!exams.length) throw new Error('所选场次已结束、已交卷或不再可用');
        if (exams.length !== requestedIds.length) log('已移除不再可作答的场次');
        storeObject(SETTINGS_KEY, { ...storedObject(SETTINGS_KEY), examIds: exams.map((exam) => exam.id), concurrency: siteLimit });
        const writer = createVaultWriter(loadVault());
        const aiStatus = await extension('getStatus');
        const totals = { read: 0, official: 0, matched: 0, ai: 0, submitted: 0, failed: 0, pending: 0 };
        const started = Date.now();
        for (const [examIndex, exam] of exams.entries()) {
          if (stopped) break;
          if (!engine.examOpen(exam)) { log(exam.name + ' 已结束，跳过'); continue; }
          await processExam(exam, writer, aiStatus, totals, batchSettings).catch((error) => {
            totals.failed += 1;
            log(exam.name + '：' + error.message, 'error');
          });
          setBar((examIndex + 1) / exams.length);
        }
        const duration = Math.round((Date.now() - started) / 1000);
        setStatus((stopped ? '已停止' : '处理结束') + ' ' + duration + 's：读取 ' + totals.read + '，网站答案 ' + totals.official + '，题库命中 ' + totals.matched + '，AI ' + totals.ai + '，作答已核验 ' + totals.submitted + '，待解答 ' + totals.pending + '，异常 ' + totals.failed);
        log('题库已保存。可刷新网站查看选项，整场交卷由你手动完成。');
      });
    } catch (error) {
      setStatus('中断：' + error.message);
      log(error.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  async function processExam(exam, writer, aiStatus, totals, batchSettings) {
    const ids = await fetchQuestionIds(exam);
    const records = [];
    log(exam.name + '：' + ids.length + ' 题 · ' + (exam.mode === 'practice' ? '官方答案模式' : '题库 + AI 模式'));
    let read = 0;
    const reading = await engine.pool(ids, siteLimit, async (id) => {
      const detail = await api.select(exam.id, id);
      const item = engine.readQuestion(exam, detail, id);
      item.officialAnswer = item.record.answer;
      item.record = writer.save({ ...item.record, submitted_answer: item.submittedAnswer, submission_status: 'unverified' });
      records.push(item);
      totals.read += 1;
      setStatus(exam.name + ' · 读取 ' + ++read + '/' + ids.length);
    }, shouldStop);
    for (const outcome of reading) if (outcome && !outcome.ok) { totals.failed += 1; log(exam.name + ' 读取：' + outcome.error.message, 'error'); }
    if (stopped) return;
    if (exam.mode === 'practice') {
      const unanswered = records.filter((item) => !item.officialAnswer);
      let done = 0;
      const probes = await engine.pool(unanswered, siteLimit, async (item) => {
        if (!engine.examOpen(exam)) throw new Error('练习已结束');
        const probe = item.record.options[0].key;
        if (!item.submittedAnswer) await api.submit(exam.id, item.record.question_id, probe);
        const current = engine.readQuestion(exam, await api.select(exam.id, item.record.question_id), item.record.question_id);
        item.officialAnswer = current.record.answer;
        item.record = writer.save({ ...current.record, submitted_answer: current.submittedAnswer, submission_status: 'unverified' });
        item.submittedAnswer = current.submittedAnswer;
        setStatus(exam.name + ' · 获取官方答案 ' + ++done + '/' + unanswered.length);
      }, shouldStop);
      for (const outcome of probes) if (outcome && !outcome.ok) { totals.failed += 1; log(exam.name + ' 获取答案：' + outcome.error.message, 'error'); }
    }
    if (stopped) return;
    const submissionTasks = [];
    const queueSubmission = (record) => {
      const promise = engine.submitVerified(exam, record, record.answer, api, shouldStop).then((saved) => {
        writer.save({ ...record, ...saved });
        totals.submitted += 1;
      }).catch((error) => {
        if (stopped) return;
        totals.failed += 1;
        log(exam.name + ' / ' + record.question_id + ' 作答待核验：' + error.message, 'error');
        try { writer.save({ ...record, submission_status: 'unverified', submission_error: error.message }); }
        catch (storageError) {
          stopped = true;
          log('任务停止：' + storageError.message, 'error');
          return { error: storageError };
        }
        return { error };
      });
      submissionTasks.push(promise);
    };
    try {
      const missing = new Map();
      for (const item of records) {
        if (stopped) break;
        let record = item.record;
        if (!record.answer) {
          try {
            const match = writer.lookup(record);
            if (match) {
              record = writer.save({ ...record, ...match });
            }
          } catch (error) {
            totals.failed += 1;
            totals.pending += 1;
            log(record.question_id + ' 题库匹配失败：' + error.message, 'error');
            continue;
          }
        }
        if (record.answer) {
          if (item.officialAnswer) totals.official += 1;
          else totals.matched += 1;
          queueSubmission(record);
        } else {
          const fingerprint = core.fingerprint(record);
          if (!missing.has(fingerprint)) missing.set(fingerprint, []);
          missing.get(fingerprint).push(record);
        }
      }
      const unresolved = [...missing.values()];
      const pendingIds = new Set(unresolved.flat().map((record) => record.exam_id + ':' + record.question_id));
      if (unresolved.length && !aiStatus.enabled) {
        const count = unresolved.reduce((sum, targets) => sum + targets.length, 0);
        log(exam.name + '：' + count + ' 题无题库答案，已收录；启用 AI 后可继续补答');
      } else if (unresolved.length && !stopped) {
        let finishedGroups = 0;
        let halted = false;
        const batches = await engine.runBatches(unresolved, async (targets, groupIndex) => {
          let remaining = targets;
          for (let attempt = 0; attempt < 2 && remaining.length && !stopped && !halted; attempt++) {
            const questions = remaining.map((items) => engine.toAIQuestion(items[0]));
            setStatus(exam.name + ' · AI 已完成 ' + finishedGroups + '/' + Math.ceil(unresolved.length / batchSettings.batchSize) + ' 组（每组最多 ' + batchSettings.batchSize + ' 题，并发 ' + batchSettings.concurrency + '）');
            let result;
            try {
              result = await extension('solveBatch', { runId, batchId: 'group-' + exam.id + '-' + groupIndex + '-' + attempt, questions, batchSettings });
            } catch (error) {
              if (/认证|权限|未启用|尚未授权|配置|模型和服务兼容性/.test(error.message)) halted = true;
              if (!attempt && !stopped && /JSON|格式|输出未完整|没有完整答案/.test(error.message)) {
                log('第 ' + (groupIndex + 1) + ' 组输出不完整，重试一次', 'error');
                continue;
              }
              throw error;
            }
            const byId = new Map(remaining.map((items) => [engine.toAIQuestion(items[0]).question_id, items]));
            if (!Array.isArray(result.answers)) throw new Error('AI 返回缺少答案列表');
            const returnedIds = new Set(result.answers.map((answer) => answer.question_id));
            const accepted = core.validateBatchResponse({ answers: result.answers }, questions.filter((question) => returnedIds.has(question.question_id)));
            for (const answer of accepted) {
              if (!answer.answer) continue;
              const items = byId.get(answer.question_id);
              if (!items) throw new Error('AI 返回未知题目 ID');
              const base = { ...items[0], answer: answer.answer, answer_source: 'ai', ai_model: result.model, answered_at: new Date().toISOString() };
              for (const record of items) {
                const mapped = core.lookupAnswer([base], record);
                if (!mapped) throw new Error('AI 答案无法映射到本题');
                const saved = writer.save({ ...record, ...mapped, ai_model: result.model, answered_at: base.answered_at });
                totals.ai += 1;
                pendingIds.delete(record.exam_id + ':' + record.question_id);
                if (!stopped) queueSubmission(saved);
              }
              byId.delete(answer.question_id);
            }
            remaining = [...byId.values()];
            if (remaining.length) log('第 ' + (groupIndex + 1) + ' 组有 ' + remaining.length + ' 题遗漏或答案无效' + (attempt ? '，保留待解答' : '，仅重试这些题'), 'error');
          }
          finishedGroups += 1;
          log(exam.name + ' · 第 ' + (groupIndex + 1) + ' 组处理完成');
        }, () => stopped || halted, batchSettings);
        for (const outcome of batches) {
          if (outcome && !outcome.ok && !stopped) {
            totals.failed += 1;
            log(exam.name + ' AI 分组失败：' + outcome.error.message, 'error');
          }
        }
      }
      totals.pending += pendingIds.size;
    } finally {
      await Promise.all(submissionTasks);
    }
  }

  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function captureCurrent() {
    if (running || refreshing || importing) return;
    const id = engine.positiveId(localStorage.getItem('exam_id'), '当前场次 ID');
    stopped = false;
    runId = crypto.randomUUID();
    setRunning(true);
    const snapshot = { captured_at: new Date().toISOString(), page: location.origin + location.pathname, exam_id: id, exams: [], metadata_keys: [], question_ids: [], questions: [], errors: [] };
    try {
      const rows = await request('GET', INDEX_API);
      if (!Array.isArray(rows)) throw new Error('场次接口没有返回列表');
      const allowed = ['id', 'exam_id', 'exam_name', 'subtitle', 'type', 'is_end', 's_time', 'e_time', 'now_time', 'group_id', 'status', 'is_show_answer', 'show_answer', 'is_practice'];
      snapshot.metadata_keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      snapshot.exams = rows.map((row) => Object.fromEntries(allowed.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])));
      const current = rows.find((row) => Number(row.exam_id) === id);
      const exam = { id, name: current?.exam_name || '场次 ' + id };
      const ids = await fetchQuestionIds(exam);
      snapshot.question_ids = ids;
      setBar(0);
      let done = 0;
      const results = await engine.pool(ids, 5, async (questionId) => {
        const detail = await api.select(id, questionId);
        if (!detail || Number(detail.id) !== questionId) throw new Error('题目 ' + questionId + ' 返回 ID 不一致');
        const fields = ['id', 'type', 'name', 'options', 'score', 'answer', 'r_answer', 'is_correct', 'is_right'];
        snapshot.questions.push(Object.fromEntries(fields.filter((key) => Object.hasOwn(detail, key)).map((key) => [key, detail[key]])));
        storeObject('exam-autofill:capture:' + id, snapshot);
        setStatus('仅采集题目 ' + ++done + '/' + ids.length + '（不作答、不调用 AI）');
        setBar(done / ids.length);
      }, shouldStop);
      snapshot.errors = results.filter((result) => result && !result.ok).map((result) => result.error.message);
      storeObject('exam-autofill:capture:' + id, snapshot);
      if (!snapshot.questions.length) throw new Error('没有采集到题目：' + snapshot.errors.join('；'));
      download('场次采集-' + id + '-' + Date.now() + '.json', JSON.stringify(snapshot, null, 2), 'application/json');
      setStatus('已采集并导出 ' + snapshot.questions.length + '/' + ids.length + ' 题' + (snapshot.errors.length ? '，失败 ' + snapshot.errors.length : ''));
      for (const error of snapshot.errors) log(error, 'error');
      log('当前场次数据已保存在浏览器并导出 JSON，可用于截止后的开发验证。');
    } catch (error) {
      if (snapshot.questions.length) download('场次采集-' + id + '-部分.json', JSON.stringify(snapshot, null, 2), 'application/json');
      throw error;
    } finally {
      setRunning(false);
    }
  }

  function exportQuestions(format) {
    const records = uniqueRecords(loadVault()).map((record) => core.exportRecord(record));
    if (!records.length) throw new Error('题库为空，请先读取一个场次');
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'json') return download('题库-' + date + '.json', JSON.stringify(records, null, 2), 'application/json');
    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.exam_name)) groups.set(record.exam_name, []);
      groups.get(record.exam_name).push(record);
    }
    const sections = [...groups].map(([name, items]) => {
      const body = items.map((record, index) => {
        const selected = new Set((record.answer || '').split(','));
        const options = record.options.map((option) => '- ' + (selected.has(option.key) ? '**' + option.key + '、' + option.text + '** ✅' : option.key + '、' + option.text)).join('\n');
        return '### ' + (index + 1) + '. ' + record.question + '\n\n> ' + record.type_name + (record.score === null ? '' : ' · ' + record.score + ' 分') + '\n\n' + options + '\n\n**答案：' + (record.answer || '待解答') + '**';
      }).join('\n\n---\n\n');
      return '## ' + name + '\n\n' + body;
    });
    download('题库-' + date + '.md', '# 题库整理\n\n共 ' + records.length + ' 题，导出于 ' + new Date().toLocaleString('zh-CN') + '\n\n' + sections.join('\n\n') + '\n', 'text/markdown');
  }

  function importItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') throw new Error('题库 JSON 必须是题目数组或旧版题库对象');
    if (Array.isArray(payload.records)) return payload.records;
    const values = Object.values(payload);
    if (!values.length || values.some((value) => !value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('题库 JSON 必须是题目数组或旧版题库对象');
    }
    return values;
  }

  function stripAIQuestionMarker(question) {
    return question.replace(/(?:\s*(?:（AI作答）|\(AI作答\)))+$/gu, '').trim();
  }

  function normalizeImportedRecord(value, index) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('题目必须是对象');
      const examId = engine.positiveId(value.exam_id, '场次 ID');
      const questionId = engine.positiveId(value.question_id, '题目 ID');
      if (typeof value.exam_name !== 'string' || !value.exam_name.trim()) throw new Error('缺少场次名称');
      if (value.answer_source === 'ai' && typeof value.question === 'string') {
        value = { ...value, question: stripAIQuestionMarker(value.question) };
      }
      return core.mergeRecord(null, { ...value, exam_id: examId, question_id: questionId, type: Number(value.type) });
    } catch (error) {
      throw new Error('第 ' + (index + 1) + ' 条题目无效：' + error.message, { cause: error });
    }
  }

  function readImportRecords(file) {
    if (!file || typeof file.text !== 'function') throw new Error('请选择 JSON 题库文件');
    if (file.size !== undefined) {
      const size = Number(file.size);
      if (!Number.isFinite(size) || size < 0) throw new Error('题库文件大小无效');
      if (size > MAX_IMPORT_BYTES) throw new Error('题库文件超过 16 MB，拒绝导入');
    }
    return file.text().then((raw) => {
      if (typeof raw !== 'string' || !raw.trim()) throw new Error('题库文件为空');
      let payload;
      try { payload = JSON.parse(raw); }
      catch (error) { throw new Error('题库文件不是有效 JSON', { cause: error }); }
      const items = importItems(payload);
      if (!items.length) throw new Error('题库文件没有题目');
      return items.map(normalizeImportedRecord);
    });
  }

  function mergeVaultRecords(existing, imported) {
    const byFingerprint = new Map();
    const add = (record, label) => {
      const key = core.fingerprint(record);
      try {
        const previous = byFingerprint.get(key);
        const identicalAnswer = previous && previous.answer === record.answer && previous.answer_source === record.answer_source && JSON.stringify(previous.options) === JSON.stringify(record.options);
        const merged = identicalAnswer ? previous : core.mergeRecord(previous, record);
        byFingerprint.set(key, previous ? { ...merged, exam_id: previous.exam_id, exam_name: previous.exam_name, question_id: previous.question_id } : merged);
      }
      catch (error) { throw new Error(label + '合并失败：' + error.message, { cause: error }); }
    };
    for (const record of Object.values(existing)) add(record, '本地题库');
    for (const [index, record] of imported.entries()) add(record, '第 ' + (index + 1) + ' 条题目');
    const vault = Object.create(null);
    for (const record of byFingerprint.values()) {
      const base = record.exam_id + ':' + record.question_id;
      let key = base;
      let version = 1;
      while (Object.hasOwn(vault, key)) key = base + ':' + version++;
      vault[key] = record;
    }
    const existingKeys = new Set(Object.values(existing).map((record) => core.fingerprint(record)));
    const importedKeys = new Set(imported.map((record) => core.fingerprint(record)));
    const matched = [...importedKeys].filter((key) => existingKeys.has(key)).length;
    return { vault, importedUnique: importedKeys.size, matched, added: importedKeys.size - matched };
  }

  function setImporting(value) {
    importing = value;
    if (value) closeExportMenu();
    for (const role of ['refresh', 'ai-settings', 'capture', 'start', 'clear', 'concurrency', 'ai-batch-size', 'ai-concurrency', 'import', 'import-file', 'export-menu-button']) el(role).disabled = value;
    if (!value) {
      el('refresh').disabled = false;
      el('ai-settings').disabled = false;
      el('capture').disabled = false;
      el('start').disabled = !currentExams.length;
      el('clear').disabled = false;
      el('concurrency').disabled = false;
      el('import').disabled = false;
      el('import-file').disabled = false;
      el('export-menu-button').disabled = false;
    }
  }

  async function importQuestions(file) {
    if (running || importing) throw new Error('已有任务正在处理题库，请结束后再导入');
    setImporting(true);
    setStatus('正在读取题库…');
    try {
      const imported = await readImportRecords(file);
      if (refreshing) setStatus('题库已读取，等待场次刷新完成…');
      while (refreshing) await sleep(50);
      setImporting(true);
      setStatus('正在合并 ' + imported.length + ' 条题目…');
      await navigator.locks.request('exam-autofill-run', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('另一个考试页面正在运行，请先停止该页面的任务');
        const existing = loadVault();
        const result = mergeVaultRecords(existing, imported);
        storeObject(VAULT_KEY, result.vault);
        refreshStats(result.vault);
        const duplicateCount = imported.length - result.importedUnique;
        setStatus('题库导入完成：新增 ' + result.added + '，合并已有 ' + result.matched + '，文件内去重 ' + duplicateCount + ' 条，共 ' + Object.keys(result.vault).length + ' 题');
        log('题库导入完成：读取 ' + imported.length + ' 条，新增 ' + result.added + '，合并已有 ' + result.matched + '，文件内重复 ' + duplicateCount);
      });
    } finally {
      setImporting(false);
    }
  }

  function openExportMenu() {
    const menu = el('export-menu');
    menu.hidden = false;
    el('export-menu-button').setAttribute('aria-expanded', 'true');
    menu.querySelector('[role="menuitem"]')?.focus();
  }

  function closeExportMenu(focusButton = false) {
    const menu = el('export-menu');
    if (menu.hidden) return;
    menu.hidden = true;
    el('export-menu-button').setAttribute('aria-expanded', 'false');
    if (focusButton) el('export-menu-button').focus();
  }

  function moveExportFocus(step) {
    const items = [...el('export-menu').querySelectorAll('[role="menuitem"]')];
    const current = items.indexOf(document.activeElement);
    items[(current + step + items.length) % items.length]?.focus();
  }

  function action(worker) {
    return () => Promise.resolve().then(worker).catch((error) => { setStatus(error.message); log(error.message, 'error'); });
  }

  for (const role of ['ai-batch-size', 'ai-concurrency']) {
    el(role).addEventListener('input', action(() => {
      const valid = ['ai-batch-size', 'ai-concurrency'].map((field) => {
        const input = el(field);
        input.setAttribute('aria-invalid', String(!input.validity.valid));
        return input.validity.valid;
      }).every(Boolean);
      if (valid) saveBatchSettings();
    }));
    el(role).addEventListener('change', action(saveBatchSettings));
  }

  let helpHovered = false;
  let tooltipHovered = false;
  let helpHideTimer;
  const showAIHelp = () => {
    clearTimeout(helpHideTimer);
    el('ai-tooltip').hidden = false;
  };
  const hideAIHelp = () => {
    clearTimeout(helpHideTimer);
    el('ai-tooltip').hidden = true;
  };
  const scheduleAIHelpHide = () => {
    clearTimeout(helpHideTimer);
    helpHideTimer = setTimeout(() => {
      if (!helpHovered && !tooltipHovered && document.activeElement !== el('ai-help')) hideAIHelp();
    }, 100);
  };
  el('ai-help').addEventListener('mouseenter', () => { helpHovered = true; showAIHelp(); });
  el('ai-help').addEventListener('mouseleave', () => { helpHovered = false; scheduleAIHelpHide(); });
  el('ai-tooltip').addEventListener('mouseenter', () => { tooltipHovered = true; showAIHelp(); });
  el('ai-tooltip').addEventListener('mouseleave', () => { tooltipHovered = false; scheduleAIHelpHide(); });
  el('ai-help').addEventListener('focus', showAIHelp);
  el('ai-help').addEventListener('blur', scheduleAIHelpHide);
  el('ai-help').addEventListener('click', showAIHelp);

  el('toggle').addEventListener('click', () => {
    const collapsed = panel.classList.toggle('eaf-collapsed');
    el('toggle').textContent = collapsed ? '+' : '—';
    el('toggle').setAttribute('aria-label', collapsed ? '展开面板' : '收起面板');
    el('toggle').setAttribute('aria-expanded', String(!collapsed));
  });
  el('refresh').addEventListener('click', action(refreshExams));
  el('ai-settings').addEventListener('click', action(async () => {
    const frame = el('ai-frame');
    const opened = frame.hidden;
    if (opened && !frame.src) frame.src = chrome.runtime.getURL('options.html') + '?embedded=1';
    frame.hidden = !opened;
    el('ai-settings').setAttribute('aria-expanded', String(opened));
    if (!opened) await refreshExams();
  }));
  el('capture').addEventListener('click', action(captureCurrent));
  el('start').addEventListener('click', action(runSelected));
  el('import').addEventListener('click', () => el('import-file').click());
  el('import-file').addEventListener('change', action(async () => {
    const input = el('import-file');
    const file = input.files?.[0];
    input.value = '';
    if (file) await importQuestions(file);
  }));
  el('stop').addEventListener('click', action(async () => {
    stopped = true;
    el('stop').disabled = true;
    setStatus('正在停止…已取得的答案会保留');
    await extension('cancelRun', { runId });
  }));
  el('export-menu-button').addEventListener('click', () => {
    if (el('export-menu').hidden) openExportMenu();
    else closeExportMenu(true);
  });
  el('export-menu-button').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openExportMenu();
    }
  });
  el('export-menu').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeExportMenu(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveExportFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveExportFocus(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      el('export-menu').querySelector('[role="menuitem"]')?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      const items = el('export-menu').querySelectorAll('[role="menuitem"]');
      items[items.length - 1]?.focus();
    }
  });
  el('export-menu').addEventListener('focusout', (event) => {
    if (!el('export-menu').contains(event.relatedTarget)) closeExportMenu();
  });
  el('export-md').addEventListener('click', action(() => { closeExportMenu(true); exportQuestions('md'); }));
  el('export-json').addEventListener('click', action(() => { closeExportMenu(true); exportQuestions('json'); }));
  document.addEventListener('click', (event) => {
    if (!panel.querySelector('.eaf-export-wrap').contains(event.target)) closeExportMenu();
    if (!el('ai-help').contains(event.target) && !el('ai-tooltip').contains(event.target)) hideAIHelp();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeExportMenu(true);
      hideAIHelp();
    }
  });
  el('clear').addEventListener('click', action(async () => {
    if (!confirm('确认清空本地已收集的题库？')) return;
    await navigator.locks.request('exam-autofill-run', { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('其他页面正在使用题库，请先停止任务');
      localStorage.removeItem(VAULT_KEY);
      refreshStats();
      log('本地题库已清空');
    });
  }));
  el('exams').addEventListener('change', action(() => {
    const settings = storedObject(SETTINGS_KEY);
    storeObject(SETTINGS_KEY, { ...settings, examIds: selectedIds() });
  }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) action(refreshExams)();
  });
  window.addEventListener('message', (event) => {
    if (event.source !== el('ai-frame').contentWindow || event.origin !== chrome.runtime.getURL('').replace(/\/$/, '') || event.data?.channel !== 'exam-autofill-settings-saved') return;
    action(async () => {
      const status = await extension('getStatus');
      renderAIStatus(status);
    })();
  });
  setInterval(() => { if (!document.hidden) action(refreshExams)(); }, 30000);
  action(() => {
    const settings = storedObject(SETTINGS_KEY);
    el('concurrency').value = String(Math.max(1, Math.min(20, Math.trunc(Number(settings.concurrency) || 5))));
    try {
      const batchSettings = engine.normalizeBatchSettings({ batchSize: settings.aiBatchSize, concurrency: settings.aiConcurrency });
      el('ai-batch-size').value = String(batchSettings.batchSize);
      el('ai-concurrency').value = String(batchSettings.concurrency);
    } catch (error) {
      log('已保存的 AI 分组设置无效，恢复为 30 题/组、并发 2：' + error.message, 'error');
      saveBatchSettings();
    }
    refreshStats();
    return refreshExams();
  })();
})();
