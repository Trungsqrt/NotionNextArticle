/**
 * lib/study/importer/import-exams.ts — Resumable, idempotent HTML exam importer
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovers all HTML exam files in a local source directory, parses embedded
 * quizData safely (no JS eval), validates all local image references, supports
 * a comprehensive `--dry-run` report, and uploads images + questions to the
 * private Notion Study System databases with resumable local checkpoints.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ExamCollection,
  StudyQuestion,
  QuestionImageRef,
  QuestionImagePlacement,
} from '../types'
import { examCollectionSchema, studyQuestionSchema } from '../schemas'
import {
  NOTION_FREE_PLAN_MAX_FILE_BYTES,
  StudyNotionUploadExpiredError,
  type StudyNotionClient,
} from '../notion-client'
import type { StudyNotionConfig } from '../config'
import {
  QUESTION_PROPS,
  mapNotionPageToStudyQuestion,
  mapStudyQuestionToNotionProperties,
} from '../repositories/mappers'
import { createNotionExamCollectionRepository } from '../repositories/exam-repo'
import { parseExamHtmlContent, type ParsedRawQuestion } from './html-parser'
import { resolveLocalImageReference } from './image-resolver'

export interface ExamDiscoverySummary {
  file: string
  examId: string
  title: string
  questionCount: number
}

export interface MissingImageReportItem {
  file: string
  questionId: string
  placement: QuestionImagePlacement
  sourceRef: string
  resolvedPath?: string
}

export interface InvalidImageReportItem {
  file: string
  questionId: string
  placement: QuestionImagePlacement
  sourceRef: string
  reason: string
}

export interface OversizedImageReportItem {
  file: string
  questionId: string
  placement: QuestionImagePlacement
  sourceRef: string
  byteLength: number
  maxFileBytes: number
  resolvedPath?: string
}

export interface DuplicateImageReportItem {
  relativePath: string
  count: number
  referencedBy: string[]
}

export interface ValidationErrorReportItem {
  file: string
  questionId: string
  message: string
}

export interface ImportDryRunReport {
  sourceDir: string
  maxFileBytes: number
  htmlFilesDiscovered: string[]
  questionsPerExam: ExamDiscoverySummary[]
  totalQuestions: number
  imageReferencesDetected: number
  uniqueImageFilesFound: number
  missingImageFiles: MissingImageReportItem[]
  invalidImageReferences: InvalidImageReportItem[]
  oversizedImageFiles: OversizedImageReportItem[]
  duplicateImageReferences: DuplicateImageReportItem[]
  validationErrors: ValidationErrorReportItem[]
  canProceedToImport: boolean
}

export interface ImportExecutionSummary {
  dryRun: boolean
  report: ImportDryRunReport
  examsUpserted: number
  questionsCreated: number
  questionsUpdated: number
  questionsSkippedUnchanged: number
  questionsRepaired: number
  imagesUploaded: number
  imagesReusedFromCheckpoint: number
  stateFilePath?: string
}

interface UploadedImageCheckpoint {
  notionBlockId: string
  originalFilename: string
  sourceRef: string
  sha256: string
  uploadedAt: string
}

interface CompletedQuestionCheckpoint {
  notionPageId: string
  contentHash: string
  contentVersion: number
  updatedAt: string
}

interface ImportStateFile {
  version: 2
  sourceDir: string
  updatedAt: string
  /**
   * Keyed by `${questionId}::${placement}::${optionId||''}::${order}::${sha256}`.
   * Intentionally scoped per questionId so every Question page owns its own
   * Notion image blocks (never reusing a block ID across different Question pages).
   */
  uploadedImagesByKey: Record<string, UploadedImageCheckpoint>
  completedQuestions: Record<string, CompletedQuestionCheckpoint>
}

interface PreparedImage {
  checkpointKey: string
  placement: QuestionImagePlacement
  optionId?: string
  order: number
  alt: string
  sourceRef: string
  originalFilename: string
  absolutePath: string
  contentType: string
  sha256: string
}

interface PreparedQuestion {
  question: StudyQuestion
  images: PreparedImage[]
  contentHash: string
}

interface PreparedExam {
  file: string
  exam: ExamCollection
  questions: PreparedQuestion[]
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function slugifyId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function deriveStableExamId(filename: string, index: number): string {
  const base = path.basename(filename, path.extname(filename))
  const numMatch = /^\s*(\d+)/.exec(base)
  const num = numMatch ? numMatch[1].padStart(2, '0') : String(index + 1).padStart(2, '0')
  if (/csa/i.test(base)) {
    return `csa-exam-${num}`
  }
  const slug = slugifyId(base).slice(0, 32) || `exam-${num}`
  return `study-${num}-${slug}`
}

function deriveStableQuestionId(examId: string, q: ParsedRawQuestion): string {
  if (q.sourceQuestionId && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(q.sourceQuestionId)) {
    if (q.sourceQuestionId.startsWith(`${examId}-`)) {
      return q.sourceQuestionId.slice(0, 128)
    }
    return `${examId}-q-${q.sourceQuestionId}`.slice(0, 128)
  }
  return `${examId}-q-${String(q.index + 1).padStart(3, '0')}`
}

export function discoverHtmlExamFiles(sourceDir: string): string[] {
  const canonicalDir = path.resolve(sourceDir)
  if (!fs.existsSync(canonicalDir) || !fs.statSync(canonicalDir).isDirectory()) {
    throw new Error(`Source directory does not exist or is not a directory: ${canonicalDir}`)
  }

  return fs
    .readdirSync(canonicalDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => path.join(canonicalDir, entry.name))
    .sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    )
}

function computeQuestionContentHash(
  q: StudyQuestion,
  images: Array<{
    placement: QuestionImagePlacement
    optionId?: string
    order: number
    sha256: string
    alt?: string
  }>
): string {
  return sha256Hex(
    JSON.stringify({
      examId: q.examId,
      questionText: q.questionText,
      questionType: q.questionType,
      options: q.options,
      correctOptionIds: q.correctOptionIds,
      explanation: q.explanation,
      topic: q.topic,
      status: q.status,
      images: images.map((img) => ({
        placement: img.placement,
        optionId: img.optionId || '',
        order: img.order,
        sha256: img.sha256,
        alt: img.alt || '',
      })),
    })
  )
}

function computeRemoteQuestionContentHash(remoteQ: StudyQuestion): string {
  return computeQuestionContentHash(
    remoteQ,
    remoteQ.imageRefs.map((ref) => ({
      placement: ref.placement || 'explanation',
      optionId: ref.optionId,
      order: ref.order ?? 0,
      sha256: ref.sha256 || '',
      alt: ref.alt || '',
    }))
  )
}

export function analyzeSourceDirectory(
  sourceDir: string,
  options?: { maxFileBytes?: number }
): {
  report: ImportDryRunReport
  preparedExams: PreparedExam[]
} {
  const maxFileBytes = options?.maxFileBytes ?? NOTION_FREE_PLAN_MAX_FILE_BYTES
  const canonicalRoot = path.resolve(sourceDir)
  const htmlFiles = discoverHtmlExamFiles(canonicalRoot)

  const questionsPerExam: ExamDiscoverySummary[] = []
  const missingImageFiles: MissingImageReportItem[] = []
  const invalidImageReferences: InvalidImageReportItem[] = []
  const oversizedImageFiles: OversizedImageReportItem[] = []
  const validationErrors: ValidationErrorReportItem[] = []
  const uniqueFilesMap = new Map<string, { count: number; referencedBy: string[] }>()
  const preparedExams: PreparedExam[] = []

  let totalQuestions = 0
  let imageReferencesDetected = 0

  for (let fileIdx = 0; fileIdx < htmlFiles.length; fileIdx++) {
    const htmlFile = htmlFiles[fileIdx]
    const fileName = path.basename(htmlFile)
    const examId = deriveStableExamId(fileName, fileIdx)
    const fallbackTitle = path.basename(htmlFile, path.extname(htmlFile))

    let parsedExam
    try {
      const htmlContent = fs.readFileSync(htmlFile, 'utf8')
      parsedExam = parseExamHtmlContent(htmlContent, fallbackTitle)
    } catch (err) {
      validationErrors.push({
        file: fileName,
        questionId: `${examId}:file`,
        message: err instanceof Error ? err.message : 'Failed to parse HTML file',
      })
      questionsPerExam.push({
        file: fileName,
        examId,
        title: fallbackTitle,
        questionCount: 0,
      })
      continue
    }

    const preparedQuestions: PreparedQuestion[] = []

    for (const rawQ of parsedExam.questions) {
      totalQuestions += 1
      const questionId = deriveStableQuestionId(examId, rawQ)
      const preparedImages: PreparedImage[] = []
      const dryRunImageRefs: QuestionImageRef[] = []

      for (const imgTag of rawQ.images) {
        imageReferencesDetected += 1
        const resolved = resolveLocalImageReference(
          imgTag.sourceRef,
          htmlFile,
          canonicalRoot,
          { maxFileBytes }
        )

        if (!resolved.ok) {
          if (resolved.kind === 'missing') {
            missingImageFiles.push({
              file: fileName,
              questionId,
              placement: imgTag.placement,
              sourceRef: imgTag.sourceRef,
              resolvedPath: resolved.resolvedPath,
            })
          } else if (resolved.kind === 'oversized') {
            oversizedImageFiles.push({
              file: fileName,
              questionId,
              placement: imgTag.placement,
              sourceRef: imgTag.sourceRef,
              byteLength: resolved.byteLength ?? 0,
              maxFileBytes: resolved.maxFileBytes ?? maxFileBytes,
              resolvedPath: resolved.resolvedPath,
            })
          } else {
            invalidImageReferences.push({
              file: fileName,
              questionId,
              placement: imgTag.placement,
              sourceRef: imgTag.sourceRef,
              reason: resolved.reason,
            })
          }
          continue
        }

        const existingUsage = uniqueFilesMap.get(resolved.relativeToSourceRoot) || {
          count: 0,
          referencedBy: [],
        }
        existingUsage.count += 1
        existingUsage.referencedBy.push(`${questionId} (${imgTag.placement})`)
        uniqueFilesMap.set(resolved.relativeToSourceRoot, existingUsage)

        const checkpointKey = `${questionId}::${imgTag.placement}::${imgTag.optionId || ''}::${imgTag.order}::${resolved.sha256}`
        preparedImages.push({
          checkpointKey,
          placement: imgTag.placement,
          optionId: imgTag.optionId,
          order: imgTag.order,
          alt: imgTag.alt,
          sourceRef: imgTag.sourceRef,
          originalFilename: resolved.originalFilename,
          absolutePath: resolved.absolutePath,
          contentType: resolved.contentType,
          sha256: resolved.sha256,
        })

        dryRunImageRefs.push({
          id: `pending-${imgTag.placement}-${imgTag.order}-${resolved.sha256.slice(0, 12)}`,
          placement: imgTag.placement,
          ...(imgTag.optionId ? { optionId: imgTag.optionId } : {}),
          order: imgTag.order,
          originalFilename: resolved.originalFilename,
          sourceRef: imgTag.sourceRef,
          sha256: resolved.sha256,
          alt: imgTag.alt,
        })
      }

      const candidateQuestion: StudyQuestion = {
        questionId,
        examId,
        questionText: rawQ.questionText,
        questionType: rawQ.questionType,
        options: rawQ.options,
        correctOptionIds: rawQ.correctOptionIds,
        explanation: rawQ.explanation,
        imageRefs: dryRunImageRefs,
        topic: rawQ.topic,
        status: 'published',
        contentVersion: 1,
      }

      const validatedQ = studyQuestionSchema.safeParse(candidateQuestion)
      if (!validatedQ.success) {
        for (const issue of validatedQ.error.issues) {
          validationErrors.push({
            file: fileName,
            questionId,
            message: `${issue.path.join('.') || 'question'}: ${issue.message}`,
          })
        }
        continue
      }

      preparedQuestions.push({
        question: validatedQ.data,
        images: preparedImages,
        contentHash: computeQuestionContentHash(validatedQ.data, preparedImages),
      })
    }

    const examCandidate: ExamCollection = {
      examId,
      title: parsedExam.title.slice(0, 200),
      description: `Imported from ${fileName}`,
      certificationCategory: /csa/i.test(parsedExam.title) || /csa/i.test(fileName) ? 'CSA' : 'ServiceNow',
      questionCount: preparedQuestions.length,
      status: 'published',
    }

    const validatedExam = examCollectionSchema.safeParse(examCandidate)
    if (!validatedExam.success) {
      validationErrors.push({
        file: fileName,
        questionId: `${examId}:exam`,
        message: validatedExam.error.issues[0]?.message || 'Invalid exam collection metadata',
      })
    } else {
      preparedExams.push({
        file: fileName,
        exam: validatedExam.data,
        questions: preparedQuestions,
      })
    }

    questionsPerExam.push({
      file: fileName,
      examId,
      title: examCandidate.title,
      questionCount: parsedExam.questions.length,
    })
  }

  const duplicateImageReferences: DuplicateImageReportItem[] = []
  for (const [relativePath, usage] of uniqueFilesMap.entries()) {
    if (usage.count > 1) {
      duplicateImageReferences.push({
        relativePath,
        count: usage.count,
        referencedBy: usage.referencedBy,
      })
    }
  }

  const canProceedToImport =
    htmlFiles.length > 0 &&
    missingImageFiles.length === 0 &&
    invalidImageReferences.length === 0 &&
    oversizedImageFiles.length === 0 &&
    validationErrors.length === 0

  return {
    report: {
      sourceDir: canonicalRoot,
      maxFileBytes,
      htmlFilesDiscovered: htmlFiles.map((f) => path.basename(f)),
      questionsPerExam,
      totalQuestions,
      imageReferencesDetected,
      uniqueImageFilesFound: uniqueFilesMap.size,
      missingImageFiles,
      invalidImageReferences,
      oversizedImageFiles,
      duplicateImageReferences,
      validationErrors,
      canProceedToImport,
    },
    preparedExams,
  }
}

function loadImportState(stateFilePath: string, sourceDir: string): ImportStateFile {
  if (fs.existsSync(stateFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as Omit<
        Partial<ImportStateFile>,
        'version'
      > & { version?: number }
      if (parsed && (parsed.version === 1 || parsed.version === 2)) {
        return {
          version: 2,
          sourceDir,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          uploadedImagesByKey: parsed.uploadedImagesByKey || {},
          completedQuestions: parsed.completedQuestions || {},
        }
      }
    } catch {
      // Fall through to clean state if corrupted
    }
  }
  return {
    version: 2,
    sourceDir,
    updatedAt: new Date().toISOString(),
    uploadedImagesByKey: {},
    completedQuestions: {},
  }
}

function saveImportState(stateFilePath: string, state: ImportStateFile): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true })
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8')
}

export async function runStudyExamImport(options: {
  sourceDir: string
  dryRun: boolean
  repair?: boolean
  maxFileBytes?: number
  stateDir?: string
  client?: StudyNotionClient
  config?: StudyNotionConfig
}): Promise<ImportExecutionSummary> {
  const maxFileBytes = options.maxFileBytes ?? NOTION_FREE_PLAN_MAX_FILE_BYTES
  const repairMode = Boolean(options.repair)
  const { report, preparedExams } = analyzeSourceDirectory(options.sourceDir, { maxFileBytes })

  if (options.dryRun) {
    return {
      dryRun: true,
      report,
      examsUpserted: 0,
      questionsCreated: 0,
      questionsUpdated: 0,
      questionsSkippedUnchanged: 0,
      questionsRepaired: 0,
      imagesUploaded: 0,
      imagesReusedFromCheckpoint: 0,
    }
  }

  if (!report.canProceedToImport) {
    throw new Error(
      `Import aborted: dry-run checks found ${report.missingImageFiles.length} missing images, ` +
        `${report.oversizedImageFiles.length} oversized images (>${(maxFileBytes / (1024 * 1024)).toFixed(1)} MB), ` +
        `${report.invalidImageReferences.length} invalid image references, and ${report.validationErrors.length} validation errors. ` +
        `Fix all issues before importing.`
    )
  }

  if (!options.client || !options.config) {
    throw new Error('StudyNotionClient and StudyNotionConfig are required for non-dry-run imports')
  }

  const client = options.client
  const config = options.config
  if (!client.uploadLocalFile || !client.appendImageBlocks) {
    throw new Error('StudyNotionClient must support uploadLocalFile and appendImageBlocks')
  }

  const stateDir = options.stateDir || path.resolve(process.cwd(), '.study-import-state')
  const stateFilePath = path.join(
    stateDir,
    `import-${sha256Hex(report.sourceDir).slice(0, 16)}.json`
  )
  const state = loadImportState(stateFilePath, report.sourceDir)

  const examRepo = createNotionExamCollectionRepository(client, config.examsDbId)

  let examsUpserted = 0
  let questionsCreated = 0
  let questionsUpdated = 0
  let questionsSkippedUnchanged = 0
  let questionsRepaired = 0
  let imagesUploaded = 0
  let imagesReusedFromCheckpoint = 0

  for (const preparedExam of preparedExams) {
    await examRepo.upsert(preparedExam.exam)
    examsUpserted += 1

    for (const item of preparedExam.questions) {
      const q = item.question
      const prevCheckpoint = state.completedQuestions[q.questionId]
      const allImagesCheckpointed = item.images.every((img) =>
        Boolean(state.uploadedImagesByKey[img.checkpointKey]?.notionBlockId)
      )

      // Verify remote Question page exists, matches expected content version & hash,
      // and has live referenced image blocks before skipping from local checkpoint.
      if (
        !repairMode &&
        prevCheckpoint &&
        prevCheckpoint.contentHash === item.contentHash &&
        allImagesCheckpointed
      ) {
        let remoteValid = false
        let remotePageDeleted = false
        try {
          const remotePage = await client.retrievePage(prevCheckpoint.notionPageId)
          if (!remotePage || remotePage.archived || remotePage.in_trash) {
            remotePageDeleted = true
          } else {
            const remoteQ = mapNotionPageToStudyQuestion(remotePage)
            const versionMatches = remoteQ.contentVersion === prevCheckpoint.contentVersion
            const hashMatches = computeRemoteQuestionContentHash(remoteQ) === item.contentHash
            const remoteBlockIds = new Set(
              remoteQ.imageRefs.map((ref) => ref.notionBlockId || ref.id).filter(Boolean)
            )
            const refsMatch = item.images.every((img) => {
              const expectedBlockId = state.uploadedImagesByKey[img.checkpointKey]?.notionBlockId
              return Boolean(expectedBlockId && remoteBlockIds.has(expectedBlockId))
            })

            if (remoteQ.questionId === q.questionId && versionMatches && hashMatches && refsMatch) {
              let blocksLive = true
              if (client.retrieveImageBlockUrl && item.images.length > 0) {
                const checkedBlocks = new Set<string>()
                for (const img of item.images) {
                  const blockId = state.uploadedImagesByKey[img.checkpointKey]!.notionBlockId
                  if (checkedBlocks.has(blockId)) continue
                  checkedBlocks.add(blockId)
                  const live = await client.retrieveImageBlockUrl(blockId)
                  if (!live?.url) {
                    blocksLive = false
                    break
                  }
                }
              }
              remoteValid = blocksLive
            }
          }
        } catch {
          remotePageDeleted = true
        }

        if (remoteValid) {
          questionsSkippedUnchanged += 1
          continue
        }

        if (remotePageDeleted) {
          // Remote page was deleted/archived — invalidate local checkpoint for this question and its images
          delete state.completedQuestions[q.questionId]
          for (const img of item.images) {
            delete state.uploadedImagesByKey[img.checkpointKey]
          }
        }
      }

      // Find or create the Question page in Notion so we have its page ID for attaching image blocks
      const existingPages = await client.queryDatabaseAll(config.questionsDbId, {
        filter: {
          property: QUESTION_PROPS.questionId,
          title: { equals: q.questionId },
        },
        pageSize: 5,
        maxPages: 1,
      })
      const existingPage = existingPages[0] || null
      let notionPageId = existingPage?.id || ''
      const isNewPage = !notionPageId

      // Hydrate per-question image checkpoints from existing remote page imageRefs
      // so --repair or lost local checkpoints never duplicate already-live image blocks.
      let remoteContentInconsistent = false
      if (existingPage) {
        try {
          const existingRemoteQ = mapNotionPageToStudyQuestion(existingPage)
          if (computeRemoteQuestionContentHash(existingRemoteQ) !== item.contentHash) {
            remoteContentInconsistent = true
          }
          for (const ref of existingRemoteQ.imageRefs) {
            const blockId = ref.notionBlockId || ref.id
            if (!blockId || !ref.sha256 || !ref.placement) continue
            const remoteKey = `${q.questionId}::${ref.placement}::${ref.optionId || ''}::${ref.order ?? 0}::${ref.sha256}`
            if (!state.uploadedImagesByKey[remoteKey]) {
              state.uploadedImagesByKey[remoteKey] = {
                notionBlockId: blockId,
                originalFilename: ref.originalFilename || '',
                sourceRef: ref.sourceRef || '',
                sha256: ref.sha256,
                uploadedAt: existingPage.last_edited_time || new Date().toISOString(),
              }
            }
          }
        } catch {
          remoteContentInconsistent = true
        }
      }

      // If the page had to be recreated, any previous per-question image block checkpoints
      // belonged to the old deleted page and must be re-uploaded to the new page.
      if (isNewPage) {
        for (const img of item.images) {
          delete state.uploadedImagesByKey[img.checkpointKey]
        }
      }

      const nextContentVersion = prevCheckpoint
        ? prevCheckpoint.contentVersion + 1
        : q.contentVersion

      if (isNewPage) {
        const created = await client.createPage(
          config.questionsDbId,
          mapStudyQuestionToNotionProperties({
            ...q,
            imageRefs: [],
            contentVersion: nextContentVersion,
          })
        )
        notionPageId = created.id
      }

      // Upload any new local images individually (never modifying image bytes) and attach
      // them to THIS Question page. Deduplicate only within the same Question page
      // (via uploadedImagesByKey and per-question pendingBySha), never across different questions.
      const finalImageRefs: QuestionImageRef[] = []
      const pendingBySha = new Map<string, { img: PreparedImage; indices: number[] }>()
      let repairedMissingBlock = false

      for (let i = 0; i < item.images.length; i++) {
        const img = item.images[i]
        let cached: UploadedImageCheckpoint | undefined =
          state.uploadedImagesByKey[img.checkpointKey]

        if (cached?.notionBlockId && client.retrieveImageBlockUrl) {
          try {
            const liveBlock = await client.retrieveImageBlockUrl(cached.notionBlockId)
            if (!liveBlock?.url) {
              delete state.uploadedImagesByKey[img.checkpointKey]
              cached = undefined
              repairedMissingBlock = true
            }
          } catch {
            delete state.uploadedImagesByKey[img.checkpointKey]
            cached = undefined
            repairedMissingBlock = true
          }
        }

        if (cached?.notionBlockId) {
          imagesReusedFromCheckpoint += 1
          finalImageRefs.push({
            id: cached.notionBlockId,
            notionBlockId: cached.notionBlockId,
            placement: img.placement,
            ...(img.optionId ? { optionId: img.optionId } : {}),
            order: img.order,
            originalFilename: img.originalFilename,
            sourceRef: img.sourceRef,
            sha256: img.sha256,
            alt: img.alt,
          })
        } else {
          finalImageRefs.push({
            id: 'placeholder',
            placement: img.placement,
            ...(img.optionId ? { optionId: img.optionId } : {}),
            order: img.order,
            originalFilename: img.originalFilename,
            sourceRef: img.sourceRef,
            sha256: img.sha256,
            alt: img.alt,
          })
          const group = pendingBySha.get(img.sha256)
          if (group) {
            group.indices.push(i)
          } else {
            pendingBySha.set(img.sha256, { img, indices: [i] })
          }
        }
      }

      const pendingUniqueUploads = [...pendingBySha.values()]
      if (pendingUniqueUploads.length > 0) {
        // Upload each unique image individually & attach with automatic single retry on expired session
        const uploadAndAttach = async () => {
          const uploadInputs: Array<{ fileUploadId: string; caption?: string }> = []
          for (const entry of pendingUniqueUploads) {
            const buffer = fs.readFileSync(entry.img.absolutePath)
            const uploaded = await client.uploadLocalFile!({
              filename: entry.img.originalFilename,
              contentType: entry.img.contentType,
              buffer,
            })
            uploadInputs.push({
              fileUploadId: uploaded.fileUploadId,
              caption: `${entry.img.placement}${entry.img.optionId ? `:${entry.img.optionId}` : ''} #${entry.img.order} (${entry.img.originalFilename})`,
            })
          }
          return client.appendImageBlocks!(notionPageId, uploadInputs)
        }

        let createdBlockIds: string[]
        try {
          createdBlockIds = await uploadAndAttach()
        } catch (err) {
          if (err instanceof StudyNotionUploadExpiredError) {
            createdBlockIds = await uploadAndAttach()
          } else {
            throw err
          }
        }

        if (createdBlockIds.length !== pendingUniqueUploads.length) {
          throw new Error(
            `Expected ${pendingUniqueUploads.length} created Notion image blocks for ${q.questionId}, received ${createdBlockIds.length}`
          )
        }

        for (let k = 0; k < pendingUniqueUploads.length; k++) {
          const { indices } = pendingUniqueUploads[k]
          const blockId = createdBlockIds[k]
          const uploadedAt = new Date().toISOString()
          imagesUploaded += 1

          for (const idx of indices) {
            const targetImg = item.images[idx]
            if (idx !== indices[0]) {
              imagesReusedFromCheckpoint += 1
            }
            state.uploadedImagesByKey[targetImg.checkpointKey] = {
              notionBlockId: blockId,
              originalFilename: targetImg.originalFilename,
              sourceRef: targetImg.sourceRef,
              sha256: targetImg.sha256,
              uploadedAt,
            }
            finalImageRefs[idx] = {
              ...finalImageRefs[idx],
              id: blockId,
              notionBlockId: blockId,
            }
          }
        }
        saveImportState(stateFilePath, state)
      }

      // Persist final Question properties with permanent Notion image block IDs (never signed URLs)
      await client.updatePage(
        notionPageId,
        mapStudyQuestionToNotionProperties({
          ...q,
          imageRefs: finalImageRefs,
          contentVersion: nextContentVersion,
        })
      )

      state.completedQuestions[q.questionId] = {
        notionPageId,
        contentHash: item.contentHash,
        contentVersion: nextContentVersion,
        updatedAt: new Date().toISOString(),
      }
      saveImportState(stateFilePath, state)

      if (isNewPage) {
        questionsCreated += 1
        if (repairMode) questionsRepaired += 1
      } else {
        questionsUpdated += 1
        if (
          repairMode &&
          (repairedMissingBlock || remoteContentInconsistent || pendingUniqueUploads.length > 0)
        ) {
          questionsRepaired += 1
        }
      }
    }
  }

  return {
    dryRun: false,
    report,
    examsUpserted,
    questionsCreated,
    questionsUpdated,
    questionsSkippedUnchanged,
    questionsRepaired,
    imagesUploaded,
    imagesReusedFromCheckpoint,
    stateFilePath,
  }
}
