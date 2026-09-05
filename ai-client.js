(() => {
  const DEFAULT_BATCH_SIZE = 30;
  const MAX_BATCH_SIZE = 100;
  const DEFAULT_CONCURRENCY = 2;
  const MAX_CONCURRENCY = 10;
  const DEFAULT_BATCH_SETTINGS = Object.freeze({ batchSize: DEFAULT_BATCH_SIZE, concurrency: DEFAULT_CONCURRENCY });
  const MAX_BATCH_SETTINGS = Object.freeze({ batchSize: MAX_BATCH_SIZE, concurrency: MAX_CONCURRENCY });
  const BATCH_SIZE = DEFAULT_BATCH_SIZE;
  const MAX_RESPONSE_LENGTH = 1000000;

  function normalizeBatchSettings(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 批次设置格式错误');
    const batchSize = value.batchSize === undefined ? DEFAULT_BATCH_SIZE : value.batchSize;
    const concurrency = value.concurrency === undefined ? DEFAULT_CONCURRENCY : value.concurrency;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new Error('每组题数必须是 1～100 的整数');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error('AI 并发必须是 1～10 的整数');
    return { batchSize, concurrency };
  }

  function normalizeConfig(value) {
    if (!value || typeof value !== 'object') throw new Error('AI 配置格式错误');
    const baseUrl = String(value.baseUrl || '').trim().replace(/\/+$/, '');
    let url;
    try {
      url = new URL(baseUrl);
    } catch (error) {
      throw new Error('Base URL 必须是完整的 http 或 https 地址', { cause: error });
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('远程 API 必须使用 HTTPS；本机 API 可以使用 HTTP');
    if (url.username || url.password || url.search || url.hash) throw new Error('Base URL 不能包含账号、密码、查询参数或锚点');
    if (/\/chat\/completions$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/chat\/completions$/, '');
    const apiKey = String(value.apiKey || '').trim();
    const model = String(value.model || '').trim();
    if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('请填写有效的模型名称');
    if ((!apiKey && !local) || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('请填写有效的 API Key');
    return { baseUrl: url.href.replace(/\/+$/, ''), apiKey, model, enabled: value.enabled === true };
  }

  function permissionOrigin(config) {
    const url = new URL(config.baseUrl);
    return `${url.protocol}//${url.hostname}/*`;
  }

  function validateQuestions(questions, maxBatchSize = DEFAULT_BATCH_SIZE) {
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > MAX_BATCH_SIZE) throw new Error('每组题数必须是 1～100 的整数');
    if (!Array.isArray(questions) || !questions.length || questions.length > maxBatchSize) throw new Error(`每次 AI 请求必须包含 1～${maxBatchSize} 道题`);
    const seen = new Set();
    for (const item of questions) {
      if (!item || typeof item.question_id !== 'string' || !/^[\w:-]{1,150}$/.test(item.question_id) || seen.has(item.question_id)) throw new Error('AI 题目 ID 缺失或重复');
      seen.add(item.question_id);
      if (![1, 2, 3].includes(item.type) || typeof item.question !== 'string' || !item.question.trim() || item.question.length > 20000) throw new Error(`${item.question_id}：题干或题型无效`);
      if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 30) throw new Error(`${item.question_id}：选项数量无效`);
      const keys = new Set();
      for (const option of item.options) {
        if (!option || typeof option.key !== 'string' || !/^[A-Z0-9]{1,5}$/.test(option.key) || keys.has(option.key) || typeof option.text !== 'string' || !option.text.trim() || option.text.length > 15000) throw new Error(`${item.question_id}：选项内容或编号无效`);
        keys.add(option.key);
      }
    }
    if (JSON.stringify(questions).length > 250000) throw new Error('本组题目过长，请缩短单题材料后重试');
    return questions;
  }

  function responseFormat(questions, mode) {
    if (mode === 'text') return undefined;
    if (mode === 'json_object') return { type: 'json_object' };
    return {
      type: 'json_schema',
      json_schema: {
        name: 'exam_answers',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['answers'],
          properties: {
            answers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['question_id', 'answers'],
                properties: {
                  question_id: { type: 'string', enum: questions.map((item) => item.question_id) },
                  answers: { type: 'array', items: { type: 'string', enum: [...new Set(questions.flatMap((item) => item.options.map((option) => option.key)))] } }
                }
              }
            }
          }
        }
      }
    };
  }

  function parseAnswers(text, questions, maxBatchSize = DEFAULT_BATCH_SIZE) {
    validateQuestions(questions, maxBatchSize);
    if (typeof text !== 'string' || text.length > MAX_RESPONSE_LENGTH) throw new Error('AI 响应为空或过长');
    const raw = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new Error('AI 返回的答案不是完整 JSON', { cause: error });
    }
    if (!payload || !Array.isArray(payload.answers)) throw new Error('AI 响应缺少 answers 数组');
    const expected = new Map(questions.map((item) => [item.question_id, item]));
    const rows = new Map();
    for (const row of payload.answers) {
      if (!row || !expected.has(row.question_id)) throw new Error('AI 返回了不属于本组的题目 ID');
      if (rows.has(row.question_id)) throw new Error(`AI 重复返回题目 ${row.question_id}`);
      rows.set(row.question_id, row);
    }
    const answers = [];
    const errors = [];
    for (const question of questions) {
      const row = rows.get(question.question_id);
      const keys = new Set(question.options.map((option) => option.key));
      let message = '';
      if (!row) message = 'AI 遗漏此题';
      else if (!Array.isArray(row.answers) || !row.answers.length) message = 'AI 未给出答案';
      else if (row.answers.some((key) => typeof key !== 'string' || !keys.has(key)) || new Set(row.answers).size !== row.answers.length) message = 'AI 返回无效或重复的选项';
      else if (question.type !== 2 && row.answers.length !== 1) message = '单选题或判断题必须且只能选择一个选项';
      if (message) errors.push({ question_id: question.question_id, message });
      else answers.push({ question_id: question.question_id, answers: question.options.filter((option) => row.answers.includes(option.key)).map((option) => option.key) });
    }
    return { answers, errors };
  }

  async function readCompletion(response) {
    if (!response.body) throw new Error('AI 返回空响应');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streaming = (response.headers.get('content-type') || '').includes('text/event-stream');
    let buffer = '';
    let content = '';
    let finishReason = '';
    let length = 0;
    let refused = false;
    const consume = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let event;
      try { event = JSON.parse(data); } catch (error) { throw new Error('AI 流式响应格式错误', { cause: error }); }
      if (event.error) throw new Error('AI 服务在生成过程中返回错误');
      const choice = event.choices?.[0];
      if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
      if (choice?.delta?.refusal) refused = true;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_LENGTH) throw new Error('AI 响应超过允许长度');
        buffer += decoder.decode(value, { stream: true });
        if (!streaming) continue;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (streaming) consume(buffer);
      else {
        let payload;
        try { payload = JSON.parse(buffer); } catch (error) { throw new Error('AI 服务返回非 JSON 内容', { cause: error }); }
        content = payload.choices?.[0]?.message?.content;
        refused = Boolean(payload.choices?.[0]?.message?.refusal);
        finishReason = payload.choices?.[0]?.finish_reason;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (refused) throw new Error('AI 未提供本组答案');
    if (finishReason && finishReason !== 'stop') throw new Error(`AI 输出未完整结束（${finishReason}）`);
    if (!finishReason || typeof content !== 'string' || !content.trim()) throw new Error('AI 响应中没有完整答案');
    return content;
  }

  const api = { BATCH_SIZE, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_BATCH_SETTINGS, MAX_BATCH_SETTINGS, normalizeBatchSettings, normalizeConfig, permissionOrigin, validateQuestions, responseFormat, parseAnswers, readCompletion };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.EAFAI = api;
})();
