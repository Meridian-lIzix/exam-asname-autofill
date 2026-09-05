(() => {
  'use strict';

  const TYPE_NAMES = Object.freeze({
    1: '单选题',
    2: '多选题',
    3: '判断题'
  });
  const SOURCES = new Set(['official', 'ai', 'unresolved']);

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  const error = (message) => {
    throw new Error(message);
  };

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function identifier(value, label) {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) error(`${label}必须是非负整数或非空字符串`);
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!normalized) error(`${label}不能为空`);
      return normalized;
    }
    error(`${label}必须是非负整数或非空字符串`);
  }

  function requestIdentifier(value, label) {
    if (typeof value !== 'string' || !value.trim()) error(`${label}必须是非空字符串`);
    return value.trim();
  }

  function text(value, label) {
    if (typeof value !== 'string') error(`${label}必须是非空字符串`);
    const normalized = value.normalize('NFC').trim();
    if (!normalized) error(`${label}不能为空`);
    return normalized;
  }

  function type(value) {
    if (!Number.isInteger(value) || !own(TYPE_NAMES, value)) error(`题型无效：${String(value)}`);
    return value;
  }

  function parseOptions(value, label) {
    if (typeof value === 'string') {
      if (!value.trim()) error(`${label} JSON 不能为空`);
      try {
        return JSON.parse(value);
      } catch (cause) {
        throw new Error(`${label} JSON 无效`, { cause });
      }
    }
    return value;
  }

  function optionEntry(value, index, requireText) {
    if (!isObject(value)) error(`选项[${index}]必须是对象`);
    let key;
    let optionText;
    if (own(value, 'key') || own(value, 'text')) {
      if (!own(value, 'key')) error(`选项[${index}]缺少 key`);
      key = value.key;
      optionText = value.text;
    } else {
      const entries = Object.entries(value);
      if (entries.length !== 1) error(`选项[${index}]必须包含唯一键值对`);
      [key, optionText] = entries[0];
    }
    if (typeof key !== 'string' || !key.trim()) error(`选项[${index}]的 key 无效`);
    const normalizedKey = key.trim();
    if (requireText || optionText !== undefined) optionText = text(optionText, `选项[${index}]的文本`);
    return optionText === undefined ? { key: normalizedKey } : { key: normalizedKey, text: optionText };
  }

  function options(value, requireText = true) {
    const parsed = parseOptions(value, '选项');
    if (!Array.isArray(parsed) || parsed.length === 0) error('选项必须是非空数组');
    const seen = new Set();
    return parsed.map((item, index) => {
      const option = optionEntry(item, index, requireText);
      if (seen.has(option.key)) error(`选项 key 重复：${option.key}`);
      seen.add(option.key);
      return option;
    });
  }

  function pick(value, names, label) {
    const present = names.filter((name) => own(value, name) && value[name] !== undefined);
    if (present.length === 0) error(`${label}缺失`);
    if (present.length > 1 && present.some((name) => value[name] !== value[present[0]])) {
      error(`${label}存在冲突字段`);
    }
    return value[present[0]];
  }

  function hasAnswer(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return Boolean(value.trim());
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  function normalizeAnswer(value, optionList, questionType) {
    const normalizedType = type(questionType);
    const normalizedOptions = options(optionList, false);
    if (!hasAnswer(value)) return null;

    let values;
    if (Array.isArray(value)) {
      values = value;
    } else if (typeof value === 'string') {
      values = value.trim().split(',');
    } else {
      error('答案必须是数组、逗号分隔字符串或空值');
    }

    if (values.length === 0) return null;
    const optionKeys = new Set(normalizedOptions.map((option) => option.key));
    const selected = new Set();
    for (const rawKey of values) {
      if (typeof rawKey !== 'string' || !rawKey.trim()) error(`答案选项无效：${String(rawKey)}`);
      const key = rawKey.trim();
      if (!optionKeys.has(key)) error(`答案包含非法选项：${key}`);
      if (selected.has(key)) error(`答案包含重复选项：${key}`);
      selected.add(key);
    }
    if ((normalizedType === 1 || normalizedType === 3) && selected.size > 1) {
      error(`${TYPE_NAMES[normalizedType]}只能有一个答案`);
    }
    return normalizedOptions.filter((option) => selected.has(option.key)).map((option) => option.key).join(',');
  }

  function normalizeQuestion(exam, detail) {
    if (!isObject(exam)) error('exam 必须是对象');
    if (!isObject(detail)) error('detail 必须是对象');
    const examId = identifier(pick(exam, ['id', 'exam_id'], '场次 id'), '场次 id');
    const examName = text(pick(exam, ['name', 'exam_name'], '场次名称'), '场次名称');
    const questionId = identifier(pick(detail, ['id', 'question_id'], '题目 id'), '题目 id');
    const normalizedType = type(detail.type);
    const question = text(pick(detail, ['name', 'question'], '题干'), '题干');
    const normalizedOptions = options(detail.options, true);
    const officialValue = detail.r_answer;
    const answer = hasAnswer(officialValue)
      ? normalizeAnswer(officialValue, normalizedOptions, normalizedType)
      : null;
    return {
      exam_id: examId,
      exam_name: examName,
      question_id: questionId,
      type: normalizedType,
      type_name: TYPE_NAMES[normalizedType],
      question,
      options: normalizedOptions,
      score: detail.score === undefined ? null : detail.score,
      answer,
      answer_source: answer === null ? 'unresolved' : 'official'
    };
  }

  function matchText(value) {
    return text(value, '文本').replace(/\s+/gu, ' ');
  }

  function fingerprint(record) {
    if (!isObject(record)) error('题库记录必须是对象');
    const normalizedType = type(record.type);
    const question = matchText(record.question);
    const normalizedOptions = options(record.options, true)
      .map((option) => matchText(option.text))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return JSON.stringify([normalizedType, question, normalizedOptions]);
  }

  function sourceOf(record) {
    const rawSource = record.answer_source;
    const source = rawSource === undefined || rawSource === null || rawSource === ''
      ? (hasAnswer(record.answer) ? 'official' : 'unresolved')
      : rawSource;
    if (!SOURCES.has(source)) error(`答案来源无效：${String(source)}`);
    if (source === 'unresolved' && hasAnswer(record.answer)) error('unresolved 记录不能带答案');
    if (source === 'ai' && !hasAnswer(record.answer)) error('ai 记录必须带答案');
    return source;
  }

  function preparedRecord(record) {
    if (!isObject(record)) error('题库记录必须是对象');
    const normalizedType = type(record.type);
    const normalizedQuestion = text(record.question, '题干');
    const normalizedOptions = options(record.options, true);
    const normalizedAnswer = hasAnswer(record.answer)
      ? normalizeAnswer(record.answer, normalizedOptions, normalizedType)
      : null;
    const source = sourceOf({ ...record, answer: normalizedAnswer });
    return {
      ...record,
      type: normalizedType,
      question: normalizedQuestion,
      options: normalizedOptions,
      answer: normalizedAnswer,
      answer_source: source
    };
  }

  function answerByText(sourceRecord, targetRecord) {
    if (!hasAnswer(sourceRecord.answer)) return null;
    const normalizedAnswer = normalizeAnswer(sourceRecord.answer, sourceRecord.options, sourceRecord.type);
    const selectedKeys = normalizedAnswer.split(',');
    const sourceOptions = options(sourceRecord.options, true);
    const targetOptions = options(targetRecord.options, true);
    const mapped = selectedKeys.map((sourceKey) => {
      const sourceMatches = sourceOptions.filter((option) => option.key === sourceKey);
      if (sourceMatches.length !== 1) error(`旧答案无法对应选项：${sourceKey}`);
      const sourceText = matchText(sourceMatches[0].text);
      const targetMatches = targetOptions.filter((option) => matchText(option.text) === sourceText);
      if (targetMatches.length !== 1) error(`选项文本重复导致答案映射歧义：${sourceText}`);
      return targetMatches[0].key;
    });
    return normalizeAnswer(mapped, targetOptions, targetRecord.type);
  }

  function lookupAnswer(records, question) {
    if (!Array.isArray(records)) error('题库记录必须是数组');
    const target = preparedRecord(question);
    const targetFingerprint = fingerprint(target);
    const candidates = records
      .map((record) => preparedRecord(record))
      .filter((record) => fingerprint(record) === targetFingerprint);
    if (candidates.length === 0) return null;

    const answers = new Map();
    for (const candidate of candidates) {
      const source = candidate.answer_source;
      if (source === 'unresolved') continue;
      const answer = answerByText(candidate, target);
      if (answer === null) continue;
      if (!answers.has(source)) answers.set(source, new Set());
      answers.get(source).add(answer);
    }

    const official = answers.get('official');
    if (official && official.size > 1) error(`题库官方答案冲突：${target.question}`);
    if (official && official.size === 1) return { answer: [...official][0], answer_source: 'official' };
    const ai = answers.get('ai');
    if (ai && ai.size > 1) error(`题库 AI 答案冲突：${target.question}`);
    if (ai && ai.size === 1) return { answer: [...ai][0], answer_source: 'ai' };
    return null;
  }

  function cloneRecord(record) {
    const normalized = preparedRecord(record);
    return { ...normalized, options: normalized.options.map((option) => ({ ...option })) };
  }

  function mergeRecord(previous, next) {
    if (previous === null || previous === undefined) return cloneRecord(next);
    if (next === null || next === undefined) return cloneRecord(previous);
    const oldRecord = preparedRecord(previous);
    const newRecord = preparedRecord(next);
    if (fingerprint(oldRecord) !== fingerprint(newRecord)) return cloneRecord(newRecord);

    const oldAnswer = oldRecord.answer_source === 'unresolved' ? null : answerByText(oldRecord, newRecord);
    const newAnswer = newRecord.answer_source === 'unresolved' ? null : answerByText(newRecord, newRecord);
    const oldSource = oldAnswer === null ? 'unresolved' : oldRecord.answer_source;
    const newSource = newAnswer === null ? 'unresolved' : newRecord.answer_source;
    const rank = { unresolved: 0, ai: 1, official: 2 };
    if (oldSource === newSource && oldAnswer !== null && newAnswer !== null && oldAnswer !== newAnswer) {
      error(`${oldSource === 'official' ? '题库官方' : '题库 AI'}答案冲突：${newRecord.question}`);
    }
    const winner = rank[oldSource] >= rank[newSource]
      ? { source: oldSource, answer: oldAnswer }
      : { source: newSource, answer: newAnswer };
    return {
      ...newRecord,
      question: oldRecord.question,
      answer: winner.answer,
      answer_source: winner.source
    };
  }

  function exportRecord(record) {
    const normalized = cloneRecord(record);
    if (normalized.answer_source !== 'ai') return normalized;
    const question = normalized.question
      .replace(/(?:\s*(?:（AI作答）|\(AI作答\)))+$/gu, '')
      .trim();
    return { ...normalized, question: `${question}（AI作答）` };
  }

  function batchQuestion(question, index) {
    if (!isObject(question)) error(`AI 题目[${index}]必须是对象`);
    const questionId = requestIdentifier(question.question_id, `AI 题目[${index}] question_id`);
    const normalizedType = type(question.type);
    const normalizedQuestion = text(question.question, `AI 题目[${index}]题干`);
    const normalizedOptions = options(question.options, true);
    return {
      ...question,
      question_id: questionId,
      type: normalizedType,
      question: normalizedQuestion,
      options: normalizedOptions
    };
  }

  function validateBatchResponse(payload, questions) {
    if (!isObject(payload)) error('AI 返回必须是对象');
    if (!Array.isArray(questions)) error('AI 题目必须是数组');
    const normalizedQuestions = questions.map(batchQuestion);
    const questionMap = new Map();
    for (const question of normalizedQuestions) {
      if (questionMap.has(question.question_id)) error(`AI 题目 question_id 重复：${question.question_id}`);
      questionMap.set(question.question_id, question);
    }
    if (!Array.isArray(payload.answers)) error('AI 返回缺少 answers 数组');

    const responseMap = new Map();
    for (const [index, item] of payload.answers.entries()) {
      if (!isObject(item)) error(`AI 返回答案[${index}]必须是对象`);
      const questionId = requestIdentifier(item.question_id, `AI 返回答案[${index}] question_id`);
      if (!questionMap.has(questionId)) error(`AI 返回了未知题目：${questionId}`);
      if (responseMap.has(questionId)) error(`AI 返回题目重复：${questionId}`);
      if (!Array.isArray(item.answers)) error(`AI 返回题目 ${questionId} 的 answers 必须是数组`);
      const question = questionMap.get(questionId);
      const answer = normalizeAnswer(item.answers, question.options, question.type);
      responseMap.set(questionId, answer);
    }

    const missing = normalizedQuestions
      .map((question) => question.question_id)
      .filter((questionId) => !responseMap.has(questionId));
    if (missing.length) error(`AI 返回缺少题目：${missing.join(', ')}`);
    return normalizedQuestions.map((question) => ({
      question_id: question.question_id,
      answer: responseMap.get(question.question_id)
    }));
  }

  const api = Object.freeze({
    normalizeQuestion,
    normalizeAnswer,
    fingerprint,
    lookupAnswer,
    mergeRecord,
    exportRecord,
    validateBatchResponse
  });

  globalThis.EAFCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
