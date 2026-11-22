import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  studyUserSchema,
  examCollectionSchema,
  studyQuestionSchema,
  fsrsCardStateSchema,
  reviewEventSchema,
  toSafeStudyUser,
  toQuestionPrompt,
  isValidModernAccessKeyHash,
} from '../../lib/study/schemas'
import {
  toChunkedRichText,
  fromChunkedRichText,
  mapStudyUserToNotionProperties,
  mapNotionPageToStudyUser,
  mapExamCollectionToNotionProperties,
  mapNotionPageToExamCollection,
  mapStudyQuestionToNotionProperties,
  mapNotionPageToStudyQuestion,
  mapFsrsCardStateToNotionProperties,
  mapNotionPageToFsrsCardState,
  mapReviewEventToNotionProperties,
  mapNotionPageToReviewEvent,
} from '../../lib/study/repositories/mappers'
import { DataIntegrityError } from '../../lib/study/repositories/interfaces'
import type { NotionPageRecord } from '../../lib/study/notion-client'
import {
  SYNTHETIC_USER,
  SYNTHETIC_EXAM,
  SYNTHETIC_SINGLE_CHOICE_QUESTION,
  SYNTHETIC_MULTI_SELECT_QUESTION,
  SYNTHETIC_CARD_STATE,
  SYNTHETIC_REVIEW_EVENT,
} from './fixtures/synthetic-study-data'

function wrapAsNotionPage(id: string, properties: Record<string, unknown>): NotionPageRecord {
  return {
    id,
    created_time: '2026-01-10T08:00:00.000Z',
    last_edited_time: '2026-02-01T10:00:00.000Z',
    properties,
  }
}

describe('Study System schemas & security invariants', () => {
  it('accepts modern salted scrypt/argon2id hashes and rejects unsalted SHA-256 or plaintext', () => {
    assert.equal(isValidModernAccessKeyHash(SYNTHETIC_USER.accessKeyHash, 'scrypt-v1'), true)
    assert.equal(
      isValidModernAccessKeyHash(
        '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
        'argon2id-v1'
      ),
      true
    )

    // Unsalted 64-hex SHA-256 must be rejected
    const unsaltedSha256 = 'a'.repeat(64)
    assert.equal(isValidModernAccessKeyHash(unsaltedSha256, 'scrypt-v1'), false)
    assert.throws(() =>
      studyUserSchema.parse({
        ...SYNTHETIC_USER,
        accessKeyHash: unsaltedSha256,
      })
    )

    // Plaintext password/key must be rejected
    assert.throws(() =>
      studyUserSchema.parse({
        ...SYNTHETIC_USER,
        accessKeyHash: 'my-secret-access-key-1234567890123456',
      })
    )
  })

  it('normalizes usernames to lowercase and strips sensitive fields in toSafeStudyUser', () => {
    const parsed = studyUserSchema.parse({
      ...SYNTHETIC_USER,
      username: '  Demo.Student  ',
    })
    assert.equal(parsed.username, 'demo.student')

    const safe = toSafeStudyUser(parsed)
    assert.equal('accessKeyHash' in safe, false)
    assert.equal('hashVersion' in safe, false)
    assert.equal(safe.userId, SYNTHETIC_USER.userId)
  })

  it('enforces single_choice and multi_select question option invariants', () => {
    // Valid single_choice & multi_select
    assert.doesNotThrow(() => studyQuestionSchema.parse(SYNTHETIC_SINGLE_CHOICE_QUESTION))
    assert.doesNotThrow(() => studyQuestionSchema.parse(SYNTHETIC_MULTI_SELECT_QUESTION))

    // single_choice with 2 correct options -> rejected
    assert.throws(() =>
      studyQuestionSchema.parse({
        ...SYNTHETIC_SINGLE_CHOICE_QUESTION,
        correctOptionIds: ['A', 'B'],
      })
    )

    // correctOptionId referencing nonexistent option -> rejected
    assert.throws(() =>
      studyQuestionSchema.parse({
        ...SYNTHETIC_SINGLE_CHOICE_QUESTION,
        correctOptionIds: ['Z'],
      })
    )

    // Duplicate option IDs -> rejected
    assert.throws(() =>
      studyQuestionSchema.parse({
        ...SYNTHETIC_SINGLE_CHOICE_QUESTION,
        options: [
          { id: 'A', text: 'First' },
          { id: 'A', text: 'Duplicate' },
        ],
        correctOptionIds: ['A'],
      })
    )
  })

  it('strips answer keys, explanation, and per-option feedback in toQuestionPrompt', () => {
    const prompt = toQuestionPrompt(SYNTHETIC_SINGLE_CHOICE_QUESTION)
    assert.equal(prompt.questionId, SYNTHETIC_SINGLE_CHOICE_QUESTION.questionId)
    assert.equal(prompt.options.length, 3)
    assert.equal('correctOptionIds' in prompt, false)
    assert.equal('explanation' in prompt, false)
    for (const opt of prompt.options) {
      assert.equal('feedback' in opt, false)
    }
  })

  it('rejects FsrsCardState with mismatched stateKey', () => {
    assert.doesNotThrow(() => fsrsCardStateSchema.parse(SYNTHETIC_CARD_STATE))
    assert.throws(() =>
      fsrsCardStateSchema.parse({
        ...SYNTHETIC_CARD_STATE,
        stateKey: 'wrong-user::q-synth-001',
      })
    )
  })

  it('validates ExamCollection and ReviewEvent schemas', () => {
    assert.doesNotThrow(() => examCollectionSchema.parse(SYNTHETIC_EXAM))
    assert.doesNotThrow(() => reviewEventSchema.parse(SYNTHETIC_REVIEW_EVENT))
  })
})

describe('Notion rich_text chunking & property round-trip mappers', () => {
  it('chunks strings longer than 2,000 chars losslessly across Notion rich_text elements', () => {
    const longText = 'S'.repeat(4505)
    const chunks = toChunkedRichText(longText)
    assert.equal(chunks.length, 3)
    assert.equal(chunks[0].text.content.length, 2000)
    assert.equal(chunks[1].text.content.length, 2000)
    assert.equal(chunks[2].text.content.length, 505)

    const reconstructed = fromChunkedRichText({ rich_text: chunks })
    assert.equal(reconstructed, longText)
  })

  it('round-trips StudyUser cleanly through Notion properties', () => {
    const props = mapStudyUserToNotionProperties(SYNTHETIC_USER)
    const mapped = mapNotionPageToStudyUser(wrapAsNotionPage('page-u1', props))
    assert.deepEqual(mapped, SYNTHETIC_USER)
  })

  it('round-trips ExamCollection cleanly through Notion properties', () => {
    const props = mapExamCollectionToNotionProperties(SYNTHETIC_EXAM)
    const mapped = mapNotionPageToExamCollection(wrapAsNotionPage('page-e1', props))
    assert.equal(mapped.examId, SYNTHETIC_EXAM.examId)
    assert.equal(mapped.title, SYNTHETIC_EXAM.title)
    assert.equal(mapped.questionCount, SYNTHETIC_EXAM.questionCount)
    assert.equal(mapped.status, SYNTHETIC_EXAM.status)
  })

  it('round-trips StudyQuestion (including long explanation & ordered options) cleanly', () => {
    const longQuestion = {
      ...SYNTHETIC_SINGLE_CHOICE_QUESTION,
      explanation: 'Detailed explanation segment. '.repeat(120).trim(), // > 3,500 chars
    }
    const props = mapStudyQuestionToNotionProperties(longQuestion)
    const mapped = mapNotionPageToStudyQuestion(wrapAsNotionPage('page-q1', props))
    assert.equal(mapped.questionId, longQuestion.questionId)
    assert.equal(mapped.explanation, longQuestion.explanation)
    assert.deepEqual(mapped.options, longQuestion.options)
    assert.deepEqual(mapped.correctOptionIds, longQuestion.correctOptionIds)
    assert.deepEqual(mapped.imageRefs, longQuestion.imageRefs)
  })

  it('throws DataIntegrityError when Notion question Options JSON is corrupted', () => {
    const props = mapStudyQuestionToNotionProperties(SYNTHETIC_SINGLE_CHOICE_QUESTION)
    props['Options JSON'] = { rich_text: [{ type: 'text', text: { content: '{not-valid-json' } }] }
    assert.throws(
      () => mapNotionPageToStudyQuestion(wrapAsNotionPage('page-bad-q', props)),
      DataIntegrityError
    )
  })

  it('round-trips FsrsCardState and ReviewEvent cleanly through Notion properties', () => {
    const stateProps = mapFsrsCardStateToNotionProperties(SYNTHETIC_CARD_STATE)
    const mappedState = mapNotionPageToFsrsCardState(wrapAsNotionPage('page-s1', stateProps))
    assert.deepEqual(mappedState, SYNTHETIC_CARD_STATE)

    const eventProps = mapReviewEventToNotionProperties(SYNTHETIC_REVIEW_EVENT)
    const mappedEvent = mapNotionPageToReviewEvent(wrapAsNotionPage('page-r1', eventProps))
    assert.deepEqual(mappedEvent, SYNTHETIC_REVIEW_EVENT)
  })
})
