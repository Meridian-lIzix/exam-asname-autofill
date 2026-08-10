(() => {
  const ASSESSMENT_API = '/api/assessment/assessmentmain';
  const QUESTION_IDS_API = '/api/assessment/getassessmentids';
  const INDEX_API = '/api/homepage/indexdata';
  const VAULT_KEY = 'exam-autofill:vault';
  const SETTINGS_KEY = 'exam-autofill:settings';
  const PROBE_ANSWER = 'A';
  const TYPE_NAMES = { 1: '单选题', 2: '多选题', 3: '判断题' };
  const TARGET_EXAM_PATTERN = /知识练习/;
  const RETRY_ATTEMPTS = 3;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class ApiError extends Error {
    constructor(message, retryable) {
      super(message);
      this.retryable = retryable;
    }
  }

  function parseMaybeJson(raw) {
    if (typeof raw !== 'string') return raw;
    if (raw.charAt(0) !== '"' && raw.charAt(0) !== '{') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function readToken() {
    for (const key of Object.keys(sessionStorage)) {
      const value = parseMaybeJson(sessionStorage.getItem(key));
      if (typeof value === 'string' && value.startsWith('eyJ')) return value;
    }
    throw new ApiError('未找到登录凭证，请先在本站登录后重试', false);
  }

  function sendRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
      if (body) xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
      xhr.setRequestHeader('Authorization', readToken());
      xhr.onload = () => {
        let payload;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          reject(new ApiError(`${url} 返回非 JSON (HTTP ${xhr.status})`, true));
          return;
        }
        if (payload.code !== 1) {
          reject(new ApiError(`${payload.msg || '接口拒绝'} (code=${payload.code})`, false));
          return;
        }
        resolve(payload.data);
      };
      xhr.onerror = () => reject(new ApiError(`${url} 网络请求失败`, true));
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  async function request(method, url, body) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await sendRequest(method, url, body);
      } catch (error) {
        if (!error.retryable || attempt >= RETRY_ATTEMPTS) throw error;
        await sleep(200 * attempt);
      }
    }
  }

  async function mapPool(items, limit, worker, shouldStop) {
    const outcomes = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        if (shouldStop()) return;
        const index = cursor;
        cursor += 1;
        try {
          outcomes[index] = { ok: true, value: await worker(items[index]) };
        } catch (error) {
          outcomes[index] = { ok: false, error };
        }
      }
    });
    await Promise.all(runners);
    return outcomes;
  }

  const fetchExams = async () => {
    const rows = await request('GET', INDEX_API);
    const seen = new Map();
    for (const row of rows) {
      if (!TARGET_EXAM_PATTERN.test(row.exam_name)) continue;
      if (!seen.has(row.exam_id)) seen.set(row.exam_id, { id: row.exam_id, name: row.exam_name });
    }
    return [...seen.values()].sort((a, b) => a.id - b.id);
  };

  const fetchQuestionIds = async (examId) => {
    const rows = await request('GET', `${QUESTION_IDS_API}?exam_id=${examId}`);
    return rows.map((row) => row.id);
  };

  const selectQuestion = (examId, questionId) =>
    request('POST', ASSESSMENT_API, { exam_id: examId, question_id: questionId, act: 'select' });

  const submitAnswer = (examId, questionId, answer) =>
    request('POST', ASSESSMENT_API, { exam_id: examId, answer, question_id: questionId, act: 'add' });

  async function processExam(exam, questionIds, concurrency, report, shouldStop) {
    const details = new Map();
    let failed = 0;

    const runPhase = async (label, items, worker) => {
      let done = 0;
      const outcomes = await mapPool(
        items,
        concurrency,
        async (item) => {
          try {
            return await worker(item);
          } finally {
            done += 1;
            report.phase(exam.name, label, done, items.length);
          }
        },
        shouldStop
      );
      for (const outcome of outcomes) {
        if (!outcome || outcome.ok) continue;
        failed += 1;
        report.error(`${exam.name} ${label}：${outcome.error.message}`);
      }
      return outcomes;
    };

    const initial = await runPhase('读取', questionIds, (id) => selectQuestion(exam.id, id));
    for (const outcome of initial) {
      if (outcome && outcome.ok) details.set(outcome.value.id, outcome.value);
    }

    const unanswered = [...details.values()].filter((detail) => !detail.r_answer);
    if (unanswered.length && !shouldStop()) {
      await runPhase('探针', unanswered, (detail) => submitAnswer(exam.id, detail.id, PROBE_ANSWER));
      const refreshed = await runPhase('回读', unanswered, (detail) => selectQuestion(exam.id, detail.id));
      for (const outcome of refreshed) {
        if (outcome && outcome.ok) details.set(outcome.value.id, outcome.value);
      }
    }

    const mismatched = [...details.values()].filter(
      (detail) => detail.r_answer && detail.answer !== detail.r_answer
    );
    if (mismatched.length && !shouldStop()) {
      await runPhase('校正', mismatched, (detail) => submitAnswer(exam.id, detail.id, detail.r_answer));
      for (const detail of mismatched) detail.answer = detail.r_answer;
    }

    const resolved = [...details.values()].filter((detail) => detail.r_answer);
    const unresolved = details.size - resolved.length;
    if (unresolved) report.error(`${exam.name}：${unresolved} 题未能取得正确答案`);

    return { resolved, probed: unanswered.length, corrected: mismatched.length, failed };
  }

  function toRecord(exam, detail) {
    return {
      exam_id: exam.id,
      exam_name: exam.name,
      question_id: detail.id,
      type: detail.type,
      type_name: TYPE_NAMES[detail.type] || `未知题型(${detail.type})`,
      question: detail.name,
      options: JSON.parse(detail.options).map((option) => {
        const [key, text] = Object.entries(option)[0];
        return { key, text };
      }),
      score: detail.score,
      answer: detail.r_answer
    };
  }

  const loadVault = () => parseMaybeJson(localStorage.getItem(VAULT_KEY)) || {};
  const saveVault = (vault) => localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  const loadSettings = () => parseMaybeJson(localStorage.getItem(SETTINGS_KEY)) || {};
  const saveSettings = (settings) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function toMarkdown(records) {
    const byExam = new Map();
    for (const record of records) {
      if (!byExam.has(record.exam_id)) byExam.set(record.exam_id, []);
      byExam.get(record.exam_id).push(record);
    }
    const sections = [...byExam.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, items]) => {
        const ordered = [...items].sort((a, b) => a.type - b.type || a.question_id - b.question_id);
        const body = ordered
          .map((item, index) => {
            const correct = new Set(item.answer.split(','));
            const options = item.options
              .map((option) =>
                correct.has(option.key)
                  ? `- **${option.key}、${option.text}** ✅`
                  : `- ${option.key}、${option.text}`
              )
              .join('\n');
            return `### ${index + 1}. ${item.question}\n\n> ${item.type_name} · ${item.score} 分\n\n${options}\n\n**答案：${item.answer}**`;
          })
          .join('\n\n---\n\n');
        return `## ${ordered[0].exam_name}\n\n${body}`;
      });
    return `# 题库整理\n\n共 ${records.length} 题，导出于 ${new Date().toLocaleString('zh-CN')}\n\n${sections.join('\n\n')}\n`;
  }

  const panel = document.createElement('div');
  panel.id = 'exam-autofill-panel';
  panel.innerHTML = `
    <header>
      <span>批量答题助手</span>
      <button type="button" data-role="toggle">—</button>
    </header>
    <section data-role="body">
      <div class="eaf-exams" data-role="exams">正在读取场次…</div>
      <label class="eaf-field">
        并发数
        <input type="number" data-role="concurrency" min="1" max="20" step="1" value="5">
      </label>
      <div class="eaf-actions">
        <button type="button" data-role="start">开始</button>
        <button type="button" data-role="stop" disabled>停止</button>
      </div>
      <div class="eaf-status" data-role="status">待命</div>
      <div class="eaf-bar"><i data-role="bar"></i></div>
      <div class="eaf-stats" data-role="stats"></div>
      <div class="eaf-actions">
        <button type="button" data-role="export-md">导出 Markdown</button>
        <button type="button" data-role="export-json">导出 JSON</button>
        <button type="button" data-role="clear">清空题库</button>
      </div>
      <div class="eaf-log" data-role="log"></div>
    </section>
  `;
  document.body.appendChild(panel);

  const el = (role) => panel.querySelector(`[data-role="${role}"]`);
  const setStatus = (text) => { el('status').textContent = text; };
  const setBar = (ratio) => { el('bar').style.width = `${Math.round(ratio * 100)}%`; };

  function log(message, level = 'info') {
    const line = document.createElement('div');
    line.className = `eaf-log-${level}`;
    line.textContent = `${new Date().toLocaleTimeString('zh-CN')} ${message}`;
    el('log').prepend(line);
    while (el('log').childElementCount > 200) el('log').lastElementChild.remove();
  }

  function refreshStats() {
    el('stats').textContent = `本地题库：${Object.keys(loadVault()).length} 题`;
  }

  let running = false;
  const shouldStop = () => !running;

  async function renderExams() {
    try {
      const exams = await fetchExams();
      const settings = loadSettings();
      const checked = new Set(settings.examIds || exams.map((exam) => exam.id));
      el('exams').innerHTML = exams
        .map((exam) => `<label><input type="checkbox" value="${exam.id}"${checked.has(exam.id) ? ' checked' : ''}> ${exam.name}</label>`)
        .join('');
      if (settings.concurrency !== undefined) el('concurrency').value = settings.concurrency;
    } catch (error) {
      el('exams').textContent = error.message;
      log(error.message, 'error');
    }
  }

  const selectedExamIds = () =>
    [...el('exams').querySelectorAll('input:checked')].map((input) => Number(input.value));

  async function run() {
    const examIds = selectedExamIds();
    if (!examIds.length) {
      log('未选择任何场次', 'error');
      return;
    }
    const concurrency = Math.max(1, Number(el('concurrency').value) || 1);
    saveSettings({ examIds, concurrency });

    running = true;
    el('start').disabled = true;
    el('stop').disabled = false;
    setBar(0);

    const exams = (await fetchExams()).filter((exam) => examIds.includes(exam.id));
    const plans = [];
    for (const exam of exams) {
      try {
        plans.push({ exam, ids: await fetchQuestionIds(exam.id) });
        log(`${exam.name}：${plans[plans.length - 1].ids.length} 题待处理`);
      } catch (error) {
        log(`${exam.name} 跳过：${error.message}`, 'error');
      }
    }
    if (!plans.length) throw new ApiError('所选场次均不可作答', false);

    const vault = loadVault();
    const totals = { probed: 0, corrected: 0, failed: 0, resolved: 0 };
    const startedAt = Date.now();

    for (let index = 0; index < plans.length; index += 1) {
      if (!running) break;
      const plan = plans[index];
      const report = {
        phase: (examName, label, done, total) => {
          setStatus(`${examName} · ${label} ${done}/${total}`);
          setBar((index + done / total / 4) / plans.length);
        },
        error: (message) => log(message, 'error')
      };

      const result = await processExam(plan.exam, plan.ids, concurrency, report, shouldStop);
      for (const detail of result.resolved) vault[detail.id] = toRecord(plan.exam, detail);
      saveVault(vault);
      refreshStats();

      totals.probed += result.probed;
      totals.corrected += result.corrected;
      totals.failed += result.failed;
      totals.resolved += result.resolved.length;
      setBar((index + 1) / plans.length);
      log(`${plan.exam.name} 完成：新答 ${result.probed}，校正 ${result.corrected}，失败 ${result.failed}`);
    }

    running = false;
    el('start').disabled = false;
    el('stop').disabled = true;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    setStatus(`结束 ${seconds}s：收录 ${totals.resolved}，新答 ${totals.probed}，校正 ${totals.corrected}，失败 ${totals.failed}`);
    log('任务结束，刷新页面即可看到全部选项已为正确答案');
  }

  el('toggle').addEventListener('click', () => {
    panel.classList.toggle('eaf-collapsed');
    el('toggle').textContent = panel.classList.contains('eaf-collapsed') ? '+' : '—';
  });

  el('start').addEventListener('click', () => {
    run().catch((error) => {
      running = false;
      el('start').disabled = false;
      el('stop').disabled = true;
      setStatus(`中断：${error.message}`);
      log(error.message, 'error');
    });
  });

  el('stop').addEventListener('click', () => {
    running = false;
    setStatus('正在停止…');
  });

  el('export-md').addEventListener('click', () => {
    const records = Object.values(loadVault());
    if (!records.length) {
      log('题库为空，先跑一次批量', 'error');
      return;
    }
    download(`题库-${new Date().toISOString().slice(0, 10)}.md`, toMarkdown(records), 'text/markdown');
  });

  el('export-json').addEventListener('click', () => {
    const records = Object.values(loadVault());
    if (!records.length) {
      log('题库为空，先跑一次批量', 'error');
      return;
    }
    download(`题库-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(records, null, 2), 'application/json');
  });

  el('clear').addEventListener('click', () => {
    if (!confirm('确认清空本地已收集的题库？')) return;
    localStorage.removeItem(VAULT_KEY);
    refreshStats();
    log('本地题库已清空');
  });

  refreshStats();
  renderExams();
})();
