import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import {
  extractQuizDataLiteralFromHtml,
  parseExamHtmlContent,
} from '../../lib/study/importer/html-parser'
import { resolveLocalImageReference } from '../../lib/study/importer/image-resolver'
import {
  analyzeSourceDirectory,
  runStudyExamImport,
} from '../../lib/study/importer/import-exams'
import {
  StudyNotionUploadExpiredError,
  type StudyNotionClient,
  type NotionPageRecord,
  type AppendImageBlockInput,
} from '../../lib/study/notion-client'
import type { StudyNotionConfig } from '../../lib/study/config'
import { fromChunkedRichText } from '../../lib/study/repositories/mappers'
import { proxy } from '../../proxy'

// Tiny valid 1x1 PNG binary (synthetic test asset)
const TINY_PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const TINY_PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function buildSyntheticExamHtml(examNum: number, extraQuestionJs = ''): string {
  return `<!doctype html>
<html>
<head><title>Synthetic Practice Exam #${examNum}</title></head>
<body>
<script>
// Synthetic quizData with unquoted keys, single quotes, and trailing commas
const quizData = [
  {
    question: '<p>Exam ${examNum} Q1: Inspect diagram <img src="./images/img_alpha.png" alt="Alpha Diagram"></p>',
    options: [
      { id: 'A', text: 'First choice <img src="./images/img_beta.png" alt="Beta Option">', feedback: 'Feedback A <img src="./images/img_alpha.png" alt="Alpha Ref">' },
      { id: 'B', text: 'Second choice' },
      { id: 'C', text: 'Third choice' },
    ],
    correct: ['B'],
    explanation: '<p>Synthetic explanation with <img src="./images/img_beta.png" alt="Beta Exp"></p>',
    topic: 'Synthetic Domain ${examNum}',
  },
  ${extraQuestionJs}
];
</script>
</body>
</html>`
}

function createMockImporterNotionClient(options?: { failFirstAppendAsExpired?: boolean }) {
  const dbTables = new Map<string, NotionPageRecord[]>()
  let pageSeq = 1
  let uploadSeq = 1
  let blockSeq = 1
  let failedOnce = false
  let uploadCallCount = 0

  const client: StudyNotionClient = {
    async queryDatabaseAll(databaseId, queryOpts = {}) {
      const rows = dbTables.get(databaseId) || []
      const filter = queryOpts.filter
      if (!filter) return rows
      const prop = filter.property as string | undefined
      const eq = (filter.title as { equals?: string } | undefined)?.equals
      if (prop && eq !== undefined) {
        return rows.filter((r) => fromChunkedRichText(r.properties[prop]) === eq)
      }
      return rows
    },
    async createPage(databaseId, properties) {
      const now = new Date().toISOString()
      const page: NotionPageRecord = {
        id: `00000000-0000-4000-8000-${String(pageSeq++).padStart(12, '0')}`,
        created_time: now,
        last_edited_time: now,
        properties,
      }
      const rows = dbTables.get(databaseId) || []
      rows.push(page)
      dbTables.set(databaseId, rows)
      return page
    },
    async updatePage(pageId, properties) {
      for (const rows of dbTables.values()) {
        const idx = rows.findIndex((r) => r.id === pageId)
        if (idx !== -1) {
          rows[idx] = {
            ...rows[idx],
            last_edited_time: new Date().toISOString(),
            properties: { ...rows[idx].properties, ...properties },
          }
          return rows[idx]
        }
      }
      throw new Error(`Page not found: ${pageId}`)
    },
    async retrievePage(pageId) {
      for (const rows of dbTables.values()) {
        const found = rows.find((r) => r.id === pageId)
        if (found) return found
      }
      throw new Error(`Page not found: ${pageId}`)
    },
    async uploadLocalFile({ filename, contentType }) {
      uploadCallCount += 1
      return {
        fileUploadId: `upload-${uploadSeq++}`,
        filename,
        contentType,
      }
    },
    async appendImageBlocks(_pageId: string, images: AppendImageBlockInput[]) {
      if (options?.failFirstAppendAsExpired && !failedOnce) {
        failedOnce = true
        throw new StudyNotionUploadExpiredError('Expired upload session')
      }
      return images.map(
        () => `11111111-1111-4111-8111-${String(blockSeq++).padStart(12, '0')}`
      )
    },
  }

  return {
    client,
    getUploadCallCount: () => uploadCallCount,
    getRows: (dbId: string) => dbTables.get(dbId) || [],
  }
}

const TEST_CONFIG: StudyNotionConfig = {
  token: 'secret_synthetic_importer_test',
  usersDbId: 'db-users',
  examsDbId: 'db-exams',
  questionsDbId: 'db-questions',
  cardStatesDbId: 'db-card-states',
  reviewEventsDbId: 'db-review-events',
  timeoutMs: 5000,
  maxRetries: 0,
  minIntervalMs: 0,
  maxPaginationPages: 10,
}

describe('Study Importer — Safe HTML Parser & Path Security', () => {
  it('safely parses embedded quizData without executing arbitrary JavaScript', () => {
    const maliciousHtml = `<script>const quizData = [{ question: process.exit(1) }];</script>`
    assert.throws(() => extractQuizDataLiteralFromHtml(maliciousHtml))

    const templateInterpHtml = '<script>const quizData = [{ question: `hello ${1 + 1}` }];</script>'
    assert.throws(() => extractQuizDataLiteralFromHtml(templateInterpHtml))

    const validParsed = parseExamHtmlContent(buildSyntheticExamHtml(1), 'Fallback')
    assert.equal(validParsed.questions.length, 1)
    assert.equal(validParsed.questions[0].images.length, 4)
    assert.deepEqual(
      validParsed.questions[0].images.map((i) => i.placement),
      ['question', 'option', 'feedback', 'explanation']
    )
  })

  it('rejects path traversal, remote URLs, data URIs, and unsupported extensions', () => {
    const tmpDir = createTempDir('study-img-sec-')
    try {
      const htmlPath = path.join(tmpDir, '1. Exam.html')
      fs.writeFileSync(htmlPath, '<html></html>')
      fs.mkdirSync(path.join(tmpDir, 'images'))
      fs.writeFileSync(path.join(tmpDir, 'images', 'ok.png'), TINY_PNG_A)

      const ok = resolveLocalImageReference('./images/ok.png', htmlPath, tmpDir)
      assert.equal(ok.ok, true)

      const traversal = resolveLocalImageReference('../../etc/passwd', htmlPath, tmpDir)
      assert.equal(traversal.ok, false)
      if (!traversal.ok) assert.equal(traversal.kind, 'invalid')

      const remote = resolveLocalImageReference('https://evil.example/img.png', htmlPath, tmpDir)
      assert.equal(remote.ok, false)
      if (!remote.ok) assert.equal(remote.kind, 'invalid')

      const dataUri = resolveLocalImageReference('data:image/png;base64,AAAA', htmlPath, tmpDir)
      assert.equal(dataUri.ok, false)
      if (!dataUri.ok) assert.equal(dataUri.kind, 'invalid')

      const missing = resolveLocalImageReference('./images/missing.png', htmlPath, tmpDir)
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.equal(missing.kind, 'missing')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Study Importer — 6-Exam Dry-Run, Resumable Upload & Private Image API', () => {
  it('discovers all 6 HTML files and produces a complete dry-run report including missing/invalid/duplicate images', () => {
    const tmpDir = createTempDir('study-dryrun-')
    try {
      fs.mkdirSync(path.join(tmpDir, 'images'))
      fs.writeFileSync(path.join(tmpDir, 'images', 'img_alpha.png'), TINY_PNG_A)
      fs.writeFileSync(path.join(tmpDir, 'images', 'img_beta.png'), TINY_PNG_B)

      for (let n = 1; n <= 6; n++) {
        const extra =
          n === 6
            ? `{
                question: 'Q2 with missing <img src="./images/not_found.png"> and remote <img src="https://evil.test/a.png">',
                options: ['Yes', 'No'],
                correct: [0],
                explanation: 'Check errors',
                topic: 'Errors',
              }`
            : ''
        fs.writeFileSync(
          path.join(tmpDir, `${n}. CSA Mock Exam #${n} Synthetic.html`),
          buildSyntheticExamHtml(n, extra)
        )
      }

      const { report } = analyzeSourceDirectory(tmpDir)
      assert.equal(report.htmlFilesDiscovered.length, 6)
      assert.equal(report.questionsPerExam.length, 6)
      assert.equal(report.totalQuestions, 7)
      assert.equal(report.uniqueImageFilesFound, 2)
      assert.equal(report.missingImageFiles.length, 1)
      assert.equal(report.invalidImageReferences.length, 1)
      assert.equal(report.duplicateImageReferences.length, 2)
      assert.equal(report.canProceedToImport, false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('imports idempotently, stores permanent Notion block IDs, skips duplicates on re-run, and retries expired uploads', async () => {
    const tmpDir = createTempDir('study-import-run-')
    const stateDir = path.join(tmpDir, '.state')
    try {
      fs.mkdirSync(path.join(tmpDir, 'images'))
      fs.writeFileSync(path.join(tmpDir, 'images', 'img_alpha.png'), TINY_PNG_A)
      fs.writeFileSync(path.join(tmpDir, 'images', 'img_beta.png'), TINY_PNG_B)
      fs.writeFileSync(
        path.join(tmpDir, '1. CSA Mock Exam #1 Synthetic.html'),
        buildSyntheticExamHtml(1)
      )

      const mock = createMockImporterNotionClient({ failFirstAppendAsExpired: true })

      // First run: recovers from expired upload session and persists permanent block IDs
      const firstRun = await runStudyExamImport({
        sourceDir: tmpDir,
        dryRun: false,
        stateDir,
        client: mock.client,
        config: TEST_CONFIG,
      })

      assert.equal(firstRun.examsUpserted, 1)
      assert.equal(firstRun.questionsCreated, 1)
      // 4 image refs across 2 unique PNG files -> only 2 unique uploads, 2 reused by SHA-256!
      assert.equal(firstRun.imagesUploaded, 2)
      assert.equal(firstRun.imagesReusedFromCheckpoint, 2)
      // Expired upload triggered a clean retry (2 initial + 2 retry = 4 upload calls)
      assert.equal(mock.getUploadCallCount(), 4)

      // Stored Question Image Refs JSON contains permanent Notion block IDs, never signed S3 URLs
      const questionRows = mock.getRows('db-questions')
      assert.equal(questionRows.length, 1)
      const rawImageRefs = fromChunkedRichText(questionRows[0].properties['Image Refs JSON'])
      assert.equal(rawImageRefs.includes('amazonaws.com'), false)
      assert.equal(rawImageRefs.includes('11111111-1111-4111-8111-'), true)

      // Second run (re-import): skips unchanged question and uploads ZERO duplicate images
      const uploadsBeforeRerun = mock.getUploadCallCount()
      const secondRun = await runStudyExamImport({
        sourceDir: tmpDir,
        dryRun: false,
        stateDir,
        client: mock.client,
        config: TEST_CONFIG,
      })

      assert.equal(secondRun.questionsSkippedUnchanged, 1)
      assert.equal(secondRun.imagesUploaded, 0)
      assert.equal(mock.getUploadCallCount(), uploadsBeforeRerun)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('enforces Notion Free Plan 5 MB per-file limit without restricting combined folder size', () => {
    const tmpDir = createTempDir('study-free-plan-')
    try {
      fs.mkdirSync(path.join(tmpDir, 'images'))
      // Two 3 MB files = 6 MB combined folder (> 5 MB), but each file is <= 5 MB -> MUST PASS
      const threeMb = Buffer.alloc(3 * 1024 * 1024, 0x41)
      fs.writeFileSync(path.join(tmpDir, 'images', 'part1.png'), threeMb)
      fs.writeFileSync(path.join(tmpDir, 'images', 'part2.png'), threeMb)

      const okHtml = `<script>const quizData = [{
        question: 'Q1 <img src="./images/part1.png">',
        options: ['A', 'B'],
        correct: [0],
        explanation: 'Exp <img src="./images/part2.png">',
        topic: 'Limits',
      }];</script>`
      fs.writeFileSync(path.join(tmpDir, '1. Exam.html'), okHtml)

      const okResult = analyzeSourceDirectory(tmpDir)
      assert.equal(okResult.report.oversizedImageFiles.length, 0)
      assert.equal(okResult.report.canProceedToImport, true)

      // One individual file > 5 MB (5 MB + 1 byte) -> MUST be reported in oversizedImageFiles
      const overFiveMb = Buffer.alloc(5 * 1024 * 1024 + 1, 0x42)
      fs.writeFileSync(path.join(tmpDir, 'images', 'too_big.png'), overFiveMb)
      const badHtml = `<script>const quizData = [{
        question: 'Q2 <img src="./images/too_big.png">',
        options: ['A', 'B'],
        correct: [0],
        explanation: 'Too large',
        topic: 'Limits',
      }];</script>`
      fs.writeFileSync(path.join(tmpDir, '2. Exam.html'), badHtml)

      const badResult = analyzeSourceDirectory(tmpDir)
      assert.equal(badResult.report.oversizedImageFiles.length, 1)
      assert.equal(badResult.report.oversizedImageFiles[0].sourceRef, './images/too_big.png')
      assert.equal(badResult.report.canProceedToImport, false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('blocks unauthenticated access to /api/study/images/[blockId] with 401 and noindex/no-store headers', () => {
    const res = proxy(
      new NextRequest('https://example.com/api/study/images/11111111-1111-4111-8111-000000000001')
    )
    assert.equal(res.status, 401)
    assert.ok(res.headers.get('x-robots-tag')?.includes('noindex'))
    assert.ok(res.headers.get('cache-control')?.includes('no-store'))
  })
})
