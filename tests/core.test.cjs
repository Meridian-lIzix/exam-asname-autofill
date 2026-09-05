const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeQuestion,
  normalizeAnswer,
  fingerprint,
  lookupAnswer,
  mergeRecord,
  exportRecord,
  validateBatchResponse
} = require('../core.js');

const exam = { id: 7, name: '知识练习 A' };

const detail = (overrides = {}) => ({
  id: 11,
  type: 2,
  name: '以下哪些是编程语言？',
  options: JSON.stringify([{ A: 'JavaScript' }, { B: 'Python' }, { C: '月亮' }]),
  score: 2,
  answer: 'C',
  r_answer: 'A,B',
  ...overrides
});

const question = normalizeQuestion(exam, detail());

test('normalizeQuestion uses r_answer and ignores user answer', () => {
  assert.deepEqual(question, {
    exam_id: 7,
    exam_name: '知识练习 A',
    question_id: 11,
    type: 2,
    type_name: '多选题',
    question: '以下哪些是编程语言？',
    options: [
      { key: 'A', text: 'JavaScript' },
      { key: 'B', text: 'Python' },
      { key: 'C', text: '月亮' }
    ],
    score: 2,
    answer: 'A,B',
    answer_source: 'official'
  });
  const unresolved = normalizeQuestion(exam, detail({ r_answer: undefined, answer: 'B' }));
  assert.equal(unresolved.answer, null);
  assert.equal(unresolved.answer_source, 'unresolved');
});

test('normalizeQuestion strictly validates identifiers, types, JSON, keys, and texts', () => {
  assert.throws(() => normalizeQuestion({}, detail()), /场次 id/);
  assert.throws(() => normalizeQuestion(exam, detail({ type: 4 })), /题型无效/);
  assert.throws(() => normalizeQuestion(exam, detail({ options: '{' })), /JSON 无效/);
  assert.throws(() => normalizeQuestion(exam, detail({ options: JSON.stringify([{ A: 'x' }, { A: 'y' }]) })), /key 重复/);
  assert.throws(() => normalizeQuestion(exam, detail({ options: JSON.stringify([{ A: ' ' }]) })), /文本不能为空/);
});

test('normalizeAnswer orders choices by option order and validates type rules', () => {
  const options = [{ key: 'C', text: 'c' }, { key: 'A', text: 'a' }, { key: 'B', text: 'b' }];
  assert.equal(normalizeAnswer('B,A', options, 2), 'A,B');
  assert.equal(normalizeAnswer(['A', 'C'], options, 2), 'C,A');
  assert.equal(normalizeAnswer('', options, 2), null);
  assert.equal(normalizeAnswer([], options, 2), null);
  assert.throws(() => normalizeAnswer('D', options, 2), /非法选项/);
  assert.throws(() => normalizeAnswer('A,A', options, 2), /重复选项/);
  assert.throws(() => normalizeAnswer('A,B', options, 1), /只能有一个/);
  assert.throws(() => normalizeAnswer('A,B', options, 3), /只能有一个/);
});

test('fingerprint ignores option keys and order but retains semantic text', () => {
  const first = normalizeQuestion(exam, detail());
  const second = normalizeQuestion(
    { id: 999, name: '另一个场次' },
    detail({
      id: 88,
      name: '  以下哪些是编程语言？  ',
      options: JSON.stringify([{ X: '月亮' }, { Y: 'Python' }, { Z: 'JavaScript' }]),
      r_answer: 'Y,Z'
    })
  );
  assert.equal(fingerprint(first), fingerprint(second));
  const negated = normalizeQuestion(exam, detail({ name: '以下哪些不是编程语言？' }));
  assert.notEqual(fingerprint(first), fingerprint(negated));
});

test('lookupAnswer maps reordered choices and prefers official records', () => {
  const reordered = normalizeQuestion(
    exam,
    detail({
      id: 12,
      options: JSON.stringify([{ X: '月亮' }, { Y: 'Python' }, { Z: 'JavaScript' }]),
      r_answer: undefined,
      answer: undefined
    })
  );
  const old = { ...question, question_id: 1 };
  assert.deepEqual(lookupAnswer([old], reordered), { answer: 'Y,Z', answer_source: 'official' });
  const ai = { ...reordered, answer: 'X', answer_source: 'ai' };
  assert.deepEqual(lookupAnswer([ai], reordered), { answer: 'X', answer_source: 'ai' });
  assert.deepEqual(lookupAnswer([], reordered), null);
});

test('lookupAnswer treats legacy answers as official and detects conflicts or ambiguity', () => {
  const reordered = normalizeQuestion(
    exam,
    detail({
      id: 12,
      options: JSON.stringify([{ X: '月亮' }, { Y: 'Python' }, { Z: 'JavaScript' }]),
      r_answer: undefined,
      answer: undefined
    })
  );
  const legacy = { ...question, answer_source: undefined, question_id: 3 };
  assert.deepEqual(lookupAnswer([legacy], reordered), { answer: 'Y,Z', answer_source: 'official' });
  const conflict = { ...question, question_id: 4, answer: 'A', answer_source: 'official' };
  assert.throws(() => lookupAnswer([question, conflict], question), /官方答案冲突/);
  const ambiguous = normalizeQuestion(exam, detail({
    options: JSON.stringify([{ A: '相同' }, { B: '相同' }, { C: '其他' }]),
    r_answer: 'A'
  }));
  assert.throws(() => lookupAnswer([ambiguous], ambiguous), /歧义/);
});

test('mergeRecord preserves an official answer, upgrades AI to official, and isolates different questions', () => {
  const ai = { ...question, answer: 'C', answer_source: 'ai', question: '以下哪些是编程语言？' };
  const unresolved = { ...question, answer: null, answer_source: 'unresolved' };
  const official = mergeRecord(ai, question);
  assert.equal(official.answer, 'A,B');
  assert.equal(official.answer_source, 'official');
  assert.equal(mergeRecord(question, ai).answer, 'A,B');
  assert.equal(mergeRecord(question, unresolved).answer, 'A,B');
  const different = mergeRecord(question, { ...ai, question: '以下哪些不是编程语言？' });
  assert.equal(different.answer, 'C');
  assert.equal(different.answer_source, 'ai');
  assert.throws(
    () => mergeRecord(
      { ...question, answer: 'A', answer_source: 'official' },
      { ...question, answer: 'B', answer_source: 'official' }
    ),
    /官方答案冲突/
  );
});

test('exportRecord marks AI answers once and keeps unresolved answers exportable', () => {
  const ai = { ...question, answer: 'A,B', answer_source: 'ai', question: '题目（AI作答）' };
  const exported = exportRecord(ai);
  assert.equal(exported.question, '题目（AI作答）');
  assert.equal(exportRecord({ ...question, answer: null, answer_source: 'unresolved' }).answer, null);
});

const batchQuestions = [
  {
    question_id: 'q-1',
    type: 1,
    question: '第一题',
    options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }]
  },
  {
    question_id: 'q-2',
    type: 2,
    question: '第二题',
    options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }, { key: 'C', text: '丙' }]
  }
];

test('validateBatchResponse accepts out of order answers and normalizes them', () => {
  assert.deepEqual(
    validateBatchResponse({ answers: [
      { question_id: 'q-2', answers: ['C', 'A'] },
      { question_id: 'q-1', answers: ['B'] }
    ] }, batchQuestions),
    [
      { question_id: 'q-1', answer: 'B' },
      { question_id: 'q-2', answer: 'A,C' }
    ]
  );
  assert.deepEqual(
    validateBatchResponse({ answers: [
      { question_id: 'q-1', answers: [] },
      { question_id: 'q-2', answers: ['B'] }
    ] }, batchQuestions)[0],
    { question_id: 'q-1', answer: null }
  );
});

test('validateBatchResponse rejects missing, duplicate, foreign, and illegal answers', () => {
  assert.throws(
    () => validateBatchResponse({ answers: [{ question_id: 'q-1', answers: ['A'] }] }, batchQuestions),
    /缺少题目/
  );
  assert.throws(
    () => validateBatchResponse({ answers: [
      { question_id: 'q-1', answers: ['A'] },
      { question_id: 'q-1', answers: ['B'] },
      { question_id: 'q-2', answers: ['A'] }
    ] }, batchQuestions),
    /题目重复/
  );
  assert.throws(
    () => validateBatchResponse({ answers: [
      { question_id: 'q-1', answers: ['A'] },
      { question_id: 'q-x', answers: ['A'] }
    ] }, batchQuestions),
    /未知题目/
  );
  assert.throws(
    () => validateBatchResponse({ answers: [
      { question_id: 'q-1', answers: ['A', 'B'] },
      { question_id: 'q-2', answers: ['A'] }
    ] }, batchQuestions),
    /只能有一个/
  );
  assert.throws(
    () => validateBatchResponse({ answers: [
      { question_id: 'q-1', answers: ['D'] },
      { question_id: 'q-2', answers: ['A'] }
    ] }, batchQuestions),
    /非法选项/
  );
});
