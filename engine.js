(() => {
  const core = typeof module !== 'undefined' && module.exports ? require('./core.js') : globalThis.EAFCore;
  const ai = typeof module !== 'undefined' && module.exports ? require('./ai-client.js') : globalThis.EAFAI;
  const BATCH_SIZE = ai.DEFAULT_BATCH_SIZE;
  const AI_CONCURRENCY = ai.DEFAULT_CONCURRENCY;

  function normalizeBatchSettings(value = {}) {
    return ai.normalizeBatchSettings(value);
  }

  function positiveId(value, label = 'ID') {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}无效`);
    return number;
  }

  function timestamp(value) {
    const number = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(number) || number <= 0) return null;
    return number > 1e12 ? number / 1000 : number;
  }

  function identifyExam(row, parent) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    let id;
    try { id = positiveId(row.exam_id, '场次 ID'); } catch (error) { throw new Error(`场次数据错误：${error.message}`, { cause: error }); }
    const rawName = typeof row.exam_name === 'string' ? row.exam_name.trim() : '';
    const subtitle = typeof row.subtitle === 'string' ? row.subtitle.trim() : '';
    const parentName = typeof parent?.exam_name === 'string' ? parent.exam_name.trim() : '';
    if (!rawName && !parentName) return null;
    if (Number(row.type) !== 2) return null;
    if (Number(row.is_end) === 2 || Number(parent?.is_end) === 2) return null;
    const startTimes = [timestamp(row.s_time), timestamp(parent?.s_time)].filter((value) => value !== null);
    const endTimes = [timestamp(row.e_time), timestamp(parent?.e_time)].filter((value) => value !== null);
    const start = startTimes.length ? Math.max(...startTimes) : null;
    const end = endTimes.length ? Math.min(...endTimes) : null;
    const now = timestamp(row.now_time ?? parent?.now_time) ?? Date.now() / 1000;
    if (!start || !end || end < start || now < start || now > end) return null;
    const label = [parentName, rawName, subtitle].filter(Boolean).join(' ');
    const mode = /每周测试|周测|测试|考试|测验/.test(label) ? 'test' : /知识练习/.test(label) ? 'practice' : null;
    if (!mode) return null;
    const name = parentName && subtitle ? `${parentName} · ${subtitle}` : rawName || parentName;
    return { id, name, mode, start, end, now, observedAt: Date.now() };
  }

  function examOpen(exam) {
    const now = exam.now + (Date.now() - exam.observedAt) / 1000;
    return now >= exam.start && now <= exam.end;
  }

  function readQuestion(exam, detail, expectedId) {
    if (!detail || typeof detail !== 'object') throw new Error('题目接口返回无效数据');
    const id = positiveId(detail.id, '题目 ID');
    if (id !== positiveId(expectedId, '预期题目 ID')) throw new Error('题目接口返回的 ID 与请求不一致');
    const record = core.normalizeQuestion(exam, { ...detail, id, type: Number(detail.type) });
    if (record.question.length > 20000 || record.options.length < 2 || record.options.length > 30) throw new Error('题干或选项长度超出支持范围');
    const submittedAnswer = core.normalizeAnswer(detail.answer, record.options, record.type);
    return { record, submittedAnswer };
  }

  async function pool(items, concurrency, worker, shouldStop = () => false) {
    if (!Array.isArray(items) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error('任务队列参数无效');
    let cursor = 0;
    const results = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!shouldStop() && cursor < items.length) {
        const index = cursor++;
        try { results[index] = { ok: true, value: await worker(items[index], index) }; }
        catch (error) { results[index] = { ok: false, error }; }
      }
    }));
    return results;
  }

  async function runBatches(items, worker, shouldStop = () => false, settings = {}) {
    if (!Array.isArray(items)) throw new Error('批次题目必须是数组');
    const { batchSize, concurrency } = normalizeBatchSettings(settings);
    const groups = [];
    for (let index = 0; index < items.length; index += batchSize) groups.push(items.slice(index, index + batchSize));
    return pool(groups, concurrency, worker, shouldStop);
  }

  function toAIQuestion(record) {
    return { question_id: `${record.exam_id}:${record.question_id}`, type: record.type, question: record.question, options: record.options.map((option) => ({ key: option.key, text: option.text })) };
  }

  async function submitVerified(exam, record, answer, api, shouldStop = () => false) {
    const expected = core.normalizeAnswer(answer, record.options, record.type);
    if (!expected) throw new Error('没有可提交的答案');
    if (shouldStop()) throw new Error('任务已停止');
    if (!examOpen(exam)) throw new Error('场次已结束');
    const current = readQuestion(exam, await api.select(exam.id, record.question_id), record.question_id);
    if (core.fingerprint(current.record) !== core.fingerprint(record)) throw new Error('题目内容已经变化，请重新读取后作答');
    const mapped = current.record.answer || core.lookupAnswer([{ ...record, answer: expected, answer_source: record.answer_source === 'ai' ? 'ai' : 'official' }], current.record)?.answer;
    if (!mapped) throw new Error('答案无法映射到当前选项');
    if (current.submittedAnswer === mapped) return { ...current.record, answer: mapped, answer_source: current.record.answer_source === 'official' ? 'official' : record.answer_source, submitted_answer: mapped, submission_status: 'verified', submitted_at: new Date().toISOString() };
    if (shouldStop()) throw new Error('任务已停止');
    if (!examOpen(exam)) throw new Error('场次已结束');
    await api.submit(exam.id, record.question_id, mapped);
    const verified = readQuestion(exam, await api.select(exam.id, record.question_id), record.question_id);
    if (core.fingerprint(verified.record) !== core.fingerprint(current.record)) throw new Error('提交后的题目内容发生变化，作答待核验');
    const saved = core.lookupAnswer([{ ...current.record, answer: mapped, answer_source: 'official' }], verified.record)?.answer;
    if (verified.submittedAnswer !== saved || verified.record.answer && verified.record.answer !== verified.submittedAnswer) throw new Error('网站保存的选项与预期或新返回的官方答案不一致，作答待核验');
    return { ...verified.record, answer: verified.record.answer || saved, answer_source: verified.record.answer ? 'official' : record.answer_source, submitted_answer: verified.submittedAnswer, submission_status: 'verified', submitted_at: new Date().toISOString() };
  }

  const api = { BATCH_SIZE, AI_CONCURRENCY, normalizeBatchSettings, positiveId, identifyExam, examOpen, readQuestion, pool, runBatches, toAIQuestion, submitVerified };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.EAFEngine = api;
})();
