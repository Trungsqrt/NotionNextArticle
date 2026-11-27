import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ExamCollection,
  StudyQuestion,
  StudyUser,
} from '../../lib/study/types'
import type { StudyRepositories } from '../../lib/study/repositories'
import { startExamSession, submitExamSession } from '../../lib/study/services/exam-service'
import {
  fisherYatesShuffle,
  formatOptionDisplayLabels,
  getOptionDisplayLabel,
  shouldPreserveOptionOrder,
} from '../../lib/study/exam-shuffle'
import { SYNTHETIC_EXAM, SYNTHETIC_USER } from './fixtures/synthetic-study-data'

const TEST_SECRET = 'mock-exam-shuffle-test-secret-0123456789'

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function createMockExamTestRepos(questionList: StudyQuestion[]) {
  const exam: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-shuffle-01',
    title: 'CSA Mock Exam Shuffle Suite',
    questionCount: questionList.length,
    status: 'published',
  }

  // Intentionally return the same cached array & object references to verify zero mutation
  const cachedQuestions = questionList
  const users = new Map<string, StudyUser>([[SYNTHETIC_USER.userId, { ...SYNTHETIC_USER }]])

  const repos: StudyRepositories = {
    users: {
      async findByUsername(username) {
        const u = username.trim().toLowerCase()
        for (const v of users.values()) if (v.username === u) return { ...v }
        return null
      },
      async findByUserId(userId) {
        const v = users.get(userId)
        return v ? { ...v } : null
      },
      async upsert(user) {
        users.set(user.userId, { ...user })
        return { ...user }
      },
    },
    exams: {
      async findByExamId(examId) {
        return examId === exam.examId ? exam : null
      },
      async list(opts) {
        return !opts?.status || exam.status === opts.status ? [exam] : []
      },
      async upsert() {
        return exam
      },
    },
    questions: {
      async findByQuestionId(questionId) {
        return cachedQuestions.find((q) => q.questionId === questionId) ?? null
      },
      async listByExamId(examId, opts) {
        if (examId !== exam.examId) return []
        if (!opts?.status) return cachedQuestions
        return cachedQuestions.filter((q) => q.status === opts.status)
      },
      async listByQuestionIds(ids) {
        const idSet = new Set(ids)
        return cachedQuestions.filter((q) => idSet.has(q.questionId))
      },
      async upsert(q) {
        return q
      },
    },
    cardStates: {
      async findByUserAndQuestion() {
        return null
      },
      async listByUser() {
        return []
      },
      async listDueByUser() {
        return []
      },
      async save(s) {
        return s
      },
    },
    reviewEvents: {
      async findByEventId() {
        return null
      },
      async findLatestByUserAndQuestion() {
        return null
      },
      async listByUser() {
        return []
      },
      async appendIfNotExists(e) {
        return { event: e, created: true }
      },
    },
  }

  return { repos, exam, cachedQuestions }
}

function buildShuffleQuestions(): StudyQuestion[] {
  return [
    {
      questionId: 'q-shuf-1',
      examId: 'exam-shuffle-01',
      questionText: 'Which table serves as the base for task records?',
      questionType: 'single_choice',
      options: [
        { id: 'A', text: 'Incident', feedback: 'Incident extends Task.' },
        { id: 'B', text: 'Task', feedback: 'Task is the base table.' },
        { id: 'C', text: 'Problem', feedback: 'Problem extends Task.' },
        { id: 'D', text: 'Change Request', feedback: 'Change Request extends Task.' },
      ],
      correctOptionIds: ['B'],
      explanation: 'Task is the core base table extended by Incident, Problem, and Change.',
      imageRefs: [
        {
          id: 'img-opt-b',
          placement: 'option',
          optionId: 'B',
          alt: 'Task table icon',
        },
        {
          id: 'img-fb-b',
          placement: 'feedback',
          optionId: 'B',
          alt: 'Task hierarchy diagram',
        },
      ],
      topic: 'Data Schema',
      status: 'published',
      contentVersion: 1,
    },
    {
      questionId: 'q-shuf-2',
      examId: 'exam-shuffle-01',
      questionText: 'Select two server-side automation mechanisms.',
      questionType: 'multi_select',
      options: [
        { id: 'A', text: 'Business Rule', feedback: 'Runs on the server.' },
        { id: 'B', text: 'Client Script', feedback: 'Runs in the browser.' },
        { id: 'C', text: 'Flow Designer', feedback: 'Orchestrates server-side logic.' },
        { id: 'D', text: 'UI Policy', feedback: 'Controls form behavior in browser.' },
      ],
      correctOptionIds: ['A', 'C'],
      explanation: 'Business Rules and Flow Designer execute server-side.',
      imageRefs: [],
      topic: 'Automation',
      status: 'published',
      contentVersion: 1,
    },
    {
      questionId: 'q-shuf-3',
      examId: 'exam-shuffle-01',
      questionText: 'Which update set state allows capturing local customizations?',
      questionType: 'single_choice',
      options: [
        { id: 'A', text: 'Complete' },
        { id: 'B', text: 'Ignore' },
        { id: 'C', text: 'In Progress' },
        { id: 'D', text: 'Committed' },
      ],
      correctOptionIds: ['C'],
      explanation: 'Only In Progress update sets capture tracked changes.',
      imageRefs: [],
      topic: 'Platform Migration',
      status: 'published',
      contentVersion: 1,
    },
    {
      questionId: 'q-shuf-4',
      examId: 'exam-shuffle-01',
      questionText: 'Which role grants full administrative privileges?',
      questionType: 'single_choice',
      options: [
        { id: 'A', text: 'itil' },
        { id: 'B', text: 'admin' },
        { id: 'C', text: 'catalog_admin' },
        { id: 'D', text: 'knowledge_admin' },
      ],
      correctOptionIds: ['B'],
      explanation: 'The admin role provides unrestricted system administration access.',
      imageRefs: [],
      topic: 'Security',
      status: 'published',
      contentVersion: 1,
    },
    {
      questionId: 'q-shuf-5',
      examId: 'exam-shuffle-01',
      questionText: 'Which components can be configured on a form layout?',
      questionType: 'single_choice',
      options: [
        { id: 'A', text: 'Fields' },
        { id: 'B', text: 'Sections' },
        { id: 'C', text: 'Annotations' },
        { id: 'D', text: 'All of the above' },
      ],
      correctOptionIds: ['D'],
      explanation: 'Fields, sections, and annotations are all configurable on form layouts.',
      imageRefs: [],
      topic: 'User Interface',
      status: 'published',
      contentVersion: 1,
    },
    {
      questionId: 'q-shuf-6',
      examId: 'exam-shuffle-01',
      questionText: 'Which statement about Access Control Rules is true?',
      questionType: 'single_choice',
      options: [
        { id: 'A', text: 'Table-level rules evaluate before field-level rules.' },
        { id: 'B', text: 'Field-level rules override denied table-level rules.' },
        { id: 'C', text: 'Roles are never evaluated in ACLs.' },
        { id: 'D', text: 'ACLs run exclusively in the browser.' },
      ],
      correctOptionIds: ['A'],
      explanation: 'Option A is correct because table-level access must pass before field rules.',
      imageRefs: [],
      topic: 'Security',
      status: 'published',
      contentVersion: 1,
    },
  ]
}

describe('Mock Exam — Question & Answer Option Randomization', () => {
  it('produces different question and option orders across new exam sessions', async () => {
    const { repos, exam } = createMockExamTestRepos(buildShuffleQuestions())
    const nowSec = 1_772_359_200

    const session1 = await startExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examId: exam.examId,
        sessionSecret: TEST_SECRET,
        nowSec,
        random: createSeededRandom(101),
      },
      repos
    )
    const session2 = await startExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examId: exam.examId,
        sessionSecret: TEST_SECRET,
        nowSec,
        random: createSeededRandom(202),
      },
      repos
    )

    assert.ok(session1 && session2)
    assert.notDeepEqual(
      session1.questions.map((q) => q.questionId),
      session2.questions.map((q) => q.questionId)
    )

    // Independent option shuffling produces different option orders on shuffleable questions
    const s1ShuffleableOrders = ['q-shuf-1', 'q-shuf-2', 'q-shuf-3', 'q-shuf-4'].map((qId) =>
      session1.questions.find((q) => q.questionId === qId)!.options.map((o) => o.id)
    )
    const s2ShuffleableOrders = ['q-shuf-1', 'q-shuf-2', 'q-shuf-3', 'q-shuf-4'].map((qId) =>
      session2.questions.find((q) => q.questionId === qId)!.options.map((o) => o.id)
    )
    assert.notDeepEqual(s1ShuffleableOrders, s2ShuffleableOrders)
  })

  it('keeps ordering stable throughout the exam, preserves it in Review Results, grades by stable option IDs, and keeps image/feedback associations intact', async () => {
    const { repos, exam } = createMockExamTestRepos(buildShuffleQuestions())
    const nowSec = 1_772_359_200

    const started = await startExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examId: exam.examId,
        sessionSecret: TEST_SECRET,
        nowSec,
        random: createSeededRandom(42),
      },
      repos
    )
    assert.ok(started)

    // Verify q-shuf-1 actually shuffled so its displayed position differs from original ID order
    const q1Prompt = started.questions.find((q) => q.questionId === 'q-shuf-1')!
    assert.notDeepEqual(
      q1Prompt.options.map((o) => o.id),
      ['A', 'B', 'C', 'D']
    )

    // Positional display labels are always A, B, C, D regardless of shuffled internal option IDs
    assert.deepEqual(
      q1Prompt.options.map((_, idx) => getOptionDisplayLabel(idx)),
      ['A', 'B', 'C', 'D']
    )

    // Grade single-choice (q-shuf-1 -> 'B'), multi-select (q-shuf-2 -> ['C', 'A'] in reverse order),
    // wrong answer (q-shuf-3 -> ['A']), and remaining skipped
    const graded = await submitExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examToken: started.examToken,
        answers: {
          'q-shuf-1': ['B'],
          'q-shuf-2': ['C', 'A'],
          'q-shuf-3': ['A'],
        },
        sessionSecret: TEST_SECRET,
        nowSec: nowSec + 180,
      },
      repos
    )

    assert.equal(graded.totalQuestions, 6)
    assert.equal(graded.correctCount, 2)
    assert.equal(graded.incorrectCount, 1)
    assert.equal(graded.skippedCount, 3)

    // Review Results question order matches started exam session order identically
    assert.deepEqual(
      graded.reviewItems.map((r) => r.questionId),
      started.questions.map((q) => q.questionId)
    )

    // Review Results option order for every question matches started exam session identically
    for (let i = 0; i < started.questions.length; i++) {
      assert.deepEqual(
        graded.reviewItems[i].prompt.options.map((o) => o.id),
        started.questions[i].options.map((o) => o.id)
      )
    }

    // Verify q-shuf-1 review item: internal IDs, images, option feedback, and positional display labels
    const q1Review = graded.reviewItems.find((r) => r.questionId === 'q-shuf-1')!
    assert.equal(q1Review.isCorrect, true)
    assert.deepEqual(q1Review.selectedOptionIds, ['B'])
    assert.deepEqual(q1Review.correctOptionIds, ['B'])

    // Display label matches the shuffled index of internal option 'B'
    const bDisplayIdx = q1Review.prompt.options.findIndex((o) => o.id === 'B')
    assert.deepEqual(
      formatOptionDisplayLabels(q1Review.prompt.options, q1Review.correctOptionIds),
      [getOptionDisplayLabel(bDisplayIdx)]
    )

    // Image refs remain associated with stable internal optionId 'B'
    assert.deepEqual(
      q1Review.prompt.imageRefs.map((img) => ({ placement: img.placement, optionId: img.optionId })),
      [
        { placement: 'option', optionId: 'B' },
        { placement: 'feedback', optionId: 'B' },
      ]
    )

    // Option feedback preserves stable optionId and follows the shuffled option order
    assert.deepEqual(
      q1Review.optionFeedback.map((fb) => fb.optionId),
      q1Review.prompt.options.map((o) => o.id)
    )
    assert.equal(
      q1Review.optionFeedback.find((fb) => fb.optionId === 'B')?.feedback,
      'Task is the base table.'
    )

    // Multi-select q-shuf-2 graded correctly by stable option IDs regardless of shuffle
    const q2Review = graded.reviewItems.find((r) => r.questionId === 'q-shuf-2')!
    assert.equal(q2Review.isCorrect, true)
    assert.deepEqual(q2Review.correctOptionIds, ['A', 'C'])
  })

  it('preserves original option order for order-dependent questions and label-referencing explanations', async () => {
    const questions = buildShuffleQuestions()
    const { repos, exam } = createMockExamTestRepos(questions)

    // Direct detector checks across order-dependent patterns
    assert.equal(
      shouldPreserveOptionOrder({
        questionText: 'Pick one:',
        options: [
          { id: 'A', text: 'Alpha' },
          { id: 'B', text: 'Beta' },
          { id: 'C', text: 'None of the above' },
        ],
        explanation: 'Neither Alpha nor Beta applies.',
      }),
      true
    )
    assert.equal(
      shouldPreserveOptionOrder({
        questionText: 'Pick one:',
        options: [
          { id: 'A', text: 'Alpha' },
          { id: 'B', text: 'Beta' },
          { id: 'C', text: 'Both A and B' },
        ],
        explanation: 'Both statements are true.',
      }),
      true
    )
    assert.equal(
      shouldPreserveOptionOrder({
        questionText: 'Choose two items:',
        options: [
          { id: 'A', text: 'First item' },
          { id: 'B', text: 'Second item' },
          { id: 'C', text: 'Third item' },
          { id: 'D', text: 'Fourth item' },
        ],
        explanation: 'Both A and C are required.',
      }),
      true
    )
    assert.equal(
      shouldPreserveOptionOrder({
        questionText: 'Which option is valid?',
        options: [
          { id: 'A', text: 'Alpha', feedback: 'See Option B for comparison.' },
          { id: 'B', text: 'Beta' },
        ],
        explanation: 'Beta is valid.',
      }),
      true
    )
    // Normal prose without label references must NOT falsely trigger preservation
    assert.equal(
      shouldPreserveOptionOrder({
        questionText: 'A Business Rule runs on the server when a record is updated.',
        options: [
          { id: 'A', text: 'Select an option a user can edit' },
          { id: 'B', text: 'Configure a table record' },
          { id: 'C', text: 'Create a workflow activity' },
        ],
        explanation: 'A server-side script executes during database operations.',
      }),
      false
    )

    // End-to-end across multiple seeds: q-shuf-5 ("All of the above") and q-shuf-6 ("Option A is correct")
    // ALWAYS retain ['A', 'B', 'C', 'D'] order in both started session and review results
    for (const seed of [1, 7, 42, 99, 1337]) {
      const started = await startExamSession(
        {
          userId: SYNTHETIC_USER.userId,
          examId: exam.examId,
          sessionSecret: TEST_SECRET,
          nowSec: 1_772_359_200,
          random: createSeededRandom(seed),
        },
        repos
      )
      assert.ok(started)
      const q5 = started.questions.find((q) => q.questionId === 'q-shuf-5')!
      const q6 = started.questions.find((q) => q.questionId === 'q-shuf-6')!
      assert.deepEqual(
        q5.options.map((o) => o.id),
        ['A', 'B', 'C', 'D']
      )
      assert.deepEqual(
        q6.options.map((o) => o.id),
        ['A', 'B', 'C', 'D']
      )
    }
  })

  it('never mutates cached source question arrays or option arrays', async () => {
    const sourceQuestions = buildShuffleQuestions()
    const beforeSnapshot = JSON.stringify(sourceQuestions)
    const { repos, exam, cachedQuestions } = createMockExamTestRepos(sourceQuestions)

    const started = await startExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examId: exam.examId,
        sessionSecret: TEST_SECRET,
        nowSec: 1_772_359_200,
        random: createSeededRandom(777),
      },
      repos
    )
    assert.ok(started)

    await submitExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examToken: started.examToken,
        answers: { 'q-shuf-1': ['B'] },
        sessionSecret: TEST_SECRET,
        nowSec: 1_772_359_300,
      },
      repos
    )

    assert.equal(JSON.stringify(cachedQuestions), beforeSnapshot)

    // Pure Fisher–Yates shuffle also never mutates its input array
    const original = ['A', 'B', 'C', 'D', 'E']
    const shuffled = fisherYatesShuffle(original, createSeededRandom(5))
    assert.deepEqual(original, ['A', 'B', 'C', 'D', 'E'])
    assert.deepEqual([...shuffled].sort(), original)
  })

  it('rejects tampered exam tokens when optionOrders is modified', async () => {
    const { repos, exam } = createMockExamTestRepos(buildShuffleQuestions())
    const started = await startExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examId: exam.examId,
        sessionSecret: TEST_SECRET,
        nowSec: 1_772_359_200,
        random: createSeededRandom(12),
      },
      repos
    )
    assert.ok(started)

    const parts = started.examToken.split('.')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    payload.optionOrders[0] = ['D', 'C', 'B', 'A']
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${parts[2]}`

    await assert.rejects(
      () =>
        submitExamSession(
          {
            userId: SYNTHETIC_USER.userId,
            examToken: tampered,
            answers: {},
            sessionSecret: TEST_SECRET,
            nowSec: 1_772_359_250,
          },
          repos
        ),
      /Invalid exam session token/
    )
  })
})
