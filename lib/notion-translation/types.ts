import type {
  BlockObjectRequest,
  BlockObjectResponse,
  Client,
  DataSourceObjectResponse,
  GetDatabaseResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from '@notionhq/client'

export const TRANSLATION_STATUS = {
  NOT_STARTED: 'Not Started',
  REQUESTED: 'Requested',
  PROCESSING: 'Processing',
  DRAFT_READY: 'Draft Ready',
  NEEDS_REVIEW: 'Needs Review',
  FAILED: 'Failed',
} as const

export type TranslationStatus =
  (typeof TRANSLATION_STATUS)[keyof typeof TRANSLATION_STATUS]

export interface GlossaryRule {
  term: string
  rule: string
}

export interface WorkerLogger {
  debug(message: string, meta?: Record<string, unknown> | Error): void
  info(message: string, meta?: Record<string, unknown> | Error): void
  warn(message: string, meta?: Record<string, unknown> | Error): void
  error(message: string, meta?: Record<string, unknown> | Error): void
  child(subPrefix: string): WorkerLogger
}

export interface RetryConfigOptions {
  isIdempotent?: boolean
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  label?: string
  logger?: WorkerLogger
}

export type NotionPropertySchemaMap = Record<string, Record<string, unknown>>

export interface ArticlesDataSourceInfo {
  databaseId: string
  dataSourceId: string
  properties: NotionPropertySchemaMap
  titlePropertyName: string
  rawDatabase: GetDatabaseResponse | null
  rawDataSource: DataSourceObjectResponse | null
}

export interface NotionPageLike {
  id: string
  url?: string
  in_trash?: boolean
  archived?: boolean
  created_time?: string
  last_edited_time?: string
  parent?: {
    type?: string
    database_id?: string
    data_source_id?: string
    page_id?: string
    workspace?: boolean
  }
  cover?: Record<string, unknown> | null
  icon?: Record<string, unknown> | null
  properties?: Record<string, Record<string, unknown>>
}

export type NotionRawBlock = BlockObjectResponse | {
  id?: string
  type: string
  has_children?: boolean
  [key: string]: unknown
}

export type BlockCategory =
  | 'translatable_text'
  | 'translatable_cells'
  | 'container'
  | 'media'
  | 'link_media'
  | 'non_translatable'
  | 'special_synced'
  | 'linked_resource'
  | 'unsupported'

export interface BlockClassification {
  type: string
  supported: boolean
  category: BlockCategory
  translatableFields: readonly string[]
  preserveFields: readonly string[]
  canHaveChildren: boolean
  requiresManualReviewNote?: boolean
  resourceType?: 'page' | 'database' | 'link_to_page'
  isCustomSliderToggle?: boolean
  isMermaidCodeBlock?: boolean
}

export interface RichTextClassification {
  translatable: boolean
  reason:
    | 'invalid_run'
    | 'inline_equation'
    | 'mention'
    | 'inline_code'
    | 'whitespace_only'
    | 'non_lexical'
    | 'human_text'
}

export interface NotionBlockNode {
  id: string
  sourceBlockId?: string
  type: string
  position: string
  depth: number
  has_children: boolean
  text: string
  raw: NotionRawBlock
  children: NotionBlockNode[]
  syncedFromBlockId?: string
  classification?: BlockClassification
}

export interface NotionBlockTree extends Array<NotionBlockNode> {
  blocks?: NotionBlockNode[]
  pageId?: string | null
  totalBlocks?: number
}

export interface UnsupportedBlockIssue {
  id: string
  type: string
  position: string
  reason?: string
}

export interface MissingMediaIssue {
  id: string
  type: string
  position: string
  url?: string
  reason: string
}

export interface LinkedResourceIssue {
  id: string
  type: string
  resourceType?: string
  position: string
  title: string
  referencedId?: string | null
  originalReferencedId?: string
  resolvedTargetId?: string
  usedLocalizedCounterpart?: boolean
  note?: string
}

export interface SyncedBlockIssue {
  id: string
  position: string
  isReference?: boolean
  syncedFromBlockId: string | null
  note?: string
}

export interface TranslationItemContext {
  articleTitle: string
  parentHeading: string
  fullBlockText: string
  prevBlockText?: string
  nextBlockText?: string
}

export interface TranslationItem {
  id: string
  kind: 'property' | 'block'
  propertyName?: string
  propertyType?: string
  sourceBlockId: string
  blockType: string
  fieldPath: string
  runIndex: number
  text: string
  leadingSpace: string
  trailingSpace: string
  annotations: Record<string, unknown> | null
  href: string | null
  context: TranslationItemContext
}

export interface TranslationManifestStats {
  totalSourceBlocks: number
  totalTranslatableBlocks: number
  totalPreservedBlocks: number
  totalNestedBlocks: number
  totalTranslatableFields: number
  unsupportedBlockCount: number
  linkedResourceCount: number
  syncedBlockCount: number
}

export interface TranslationManifest {
  articleTitle: string
  sourcePageId: string | null
  items: TranslationItem[]
  itemsById: Map<string, TranslationItem>
  stats: TranslationManifestStats
  unsupportedBlocks: UnsupportedBlockIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
}

export interface AiProviderTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface AiProviderStructuredResponse {
  __isStructuredAiResponse: true
  data: unknown
  usage?: AiProviderTokenUsage
  finishReason?: string
}

export interface AiProviderRequest {
  systemPrompt: string
  userPrompt: string
  batchItems: TranslationItem[]
  targetLocale: string
  attempt: number
  estimatedOutputTokens?: number
}

export type AiProviderAdapter = (
  request: AiProviderRequest
) => Promise<unknown>

export interface TranslationUsageStats {
  provider: string
  model: string
  apiRequests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedSegments: number
  skippedTechnicalSegments: number
  translatedSegments: number
  failedBatches: number
  estimatedCostUsd: number | null
}

export interface TranslateManifestStats {
  totalRequested: number
  totalTranslated: number
  batchCount: number
  retryCount: number
  reusedFromCheckpoint?: boolean
  usage?: TranslationUsageStats
}

export interface TranslateManifestResult {
  targetLocale: string
  translationsById: Map<string, string>
  translations: Record<string, string>
  stats: TranslateManifestStats
  issues: string[]
}

export interface TranslatedPagePropertiesPayload {
  properties: Record<string, unknown>
  translatedTitle: string
  slug: string
  translationGroupId: string
  locale: string
  status: 'Draft'
}

export interface UploadedAssetRecord {
  fileUploadId: string
  filename: string
  contentType: string
  uploadedAt?: string
}

export interface CompletedBatchRecord {
  parentBlockId: string
  batchIndex: number
  expectedStartIndex: number
  sourceBlockIds: string[]
  targetBlockIds: string[]
  blockFingerprints: string[]
  completedAt: string
}

export type PendingWriteOperation =
  | {
      type: 'create_page'
      slug: string
      startedAt: string
    }
  | {
      type: 'append_blocks'
      batchKey: string
      parentBlockId: string
      batchIndex: number
      expectedStartIndex: number
      sourceBlockIds: string[]
      blockFingerprints: string[]
      startedAt: string
    }

export interface WriteIssuesCollection {
  missingMedia: MissingMediaIssue[]
  unsupportedBlocks: UnsupportedBlockIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
}

export type CheckpointJobState =
  | 'initialized'
  | 'translating'
  | 'translated'
  | 'writing'
  | 'paused_quota'
  | 'failed'
  | 'needs_review'
  | 'completed'

export interface CachedTranslationSnapshot {
  targetLocale: string
  translations: Record<string, string>
  stats: Partial<TranslateManifestStats>
  issues: string[]
  cachedAt: string
}

export interface JobCheckpoint {
  version: 1
  sourcePageId: string
  sourceFingerprint: string | null
  translationGroupId: string
  targetLocale: string
  targetPageId: string | null
  pagePropertiesWritten: boolean
  jobState: CheckpointJobState
  cachedTranslationResult: CachedTranslationSnapshot | null
  uploadedAssetsBySourceKey: Record<string, UploadedAssetRecord>
  completedBatches: Record<string, CompletedBatchRecord>
  sourceToTargetBlockMap: Record<string, string>
  childTargetPageIdsBySourceId?: Record<string, string>
  writeIssues: WriteIssuesCollection
  pendingOperation: PendingWriteOperation | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface CheckpointController {
  readonly state: JobCheckpoint
  save(): JobCheckpoint | null
  resetForSourceChange(
    newFingerprint: string,
    translationGroupId: string,
    targetLocale: string
  ): void
  setMetadata(meta: {
    sourceFingerprint?: string
    translationGroupId?: string
    targetLocale?: string
    jobState?: CheckpointJobState
  }): void
  getCachedTranslationResult(
    expectedFingerprint?: string,
    expectedLocale?: string
  ): CachedTranslationSnapshot | null
  setCachedTranslationResult(
    translationResult: TranslateManifestResult,
    sourceFingerprint?: string
  ): void
  setTargetPageId(targetPageId: string): void
  markPagePropertiesWritten(targetPageId?: string): void
  isPagePropertiesWritten(targetPageId: string): boolean
  getUploadedAsset(sourceKey: string): UploadedAssetRecord | null
  recordUploadedAsset(sourceKey: string, uploadInfo: UploadedAssetRecord): void
  getCompletedBatch(batchKey: string): CompletedBatchRecord | null
  recordCompletedBatch(params: {
    batchKey: string
    parentBlockId: string
    batchIndex: number
    expectedStartIndex: number
    sourceBlockIds: string[]
    targetBlockIds: string[]
    blockFingerprints: string[]
  }): void
  getChildTargetPageId(sourceChildPageId: string): string | null
  recordChildTargetPageId(
    sourceChildPageId: string,
    targetChildPageId: string
  ): void
  getPendingOperation(): PendingWriteOperation | null
  recordPendingOperation(op: PendingWriteOperation): void
  recordWriteIssues(issues: Partial<WriteIssuesCollection>): void
  setJobState(jobState: CheckpointJobState, lastError?: string | null): void
  remove(): void
}

export interface WriterStats {
  totalWrittenTopOrBatchBlocks: number
  totalRecreatedNestedBlocks: number
}

export interface WriterResult {
  targetPage: {
    id: string
    url?: string
    properties?: Record<string, unknown>
  }
  stats: WriterStats
  missingMedia: MissingMediaIssue[]
  unsupportedBlocks: UnsupportedBlockIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
  dryRun: boolean
}

export interface StructuralValidationResult {
  valid: boolean
  needsReview: boolean
  fidelity100Percent: boolean
  sourceCountsByType: Record<string, number>
  targetCountsByType: Record<string, number>
  validationErrors: string[]
  warnings: string[]
  unsupportedBlocks: UnsupportedBlockIssue[]
  missingMedia: MissingMediaIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
}

export interface TranslationReport {
  sourcePageTitle: string
  sourcePageId: string
  targetPageId: string
  targetPageUrl: string
  totalSourceBlocks: number
  totalTranslatedTextFields: number
  totalPreservedBlocks: number
  totalRecreatedNestedBlocks: number
  unsupportedBlocks: UnsupportedBlockIssue[]
  missingMedia: MissingMediaIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
  validationErrors: string[]
  warnings: string[]
  completedAt: string
  durationMs: number | null
  fullText: string
  concisePropertySummary: string
}

export interface PageWorkflowMeta {
  id: string
  url: string
  inTrash: boolean
  title: string
  slug: string
  status: string
  locale: string
  rawLocale: string
  translationGroupId: string
  translationStatus: string
  translationError: string
  translationTargetPageId: string
  translationUpdatedAt: string
}

export interface IndexedDatabasePage {
  page: NotionPageLike
  meta: PageWorkflowMeta
}

export interface DatabasePageIndices {
  existingSlugs: Set<string>
  pagesByGroupAndLocale: Map<string, Map<string, IndexedDatabasePage[]>>
  metaByPageId: Map<string, IndexedDatabasePage>
  localizedPageMap: Map<string, PageWorkflowMeta>
}

export type ExistingTranslationInspection =
  | {
      action: 'create_new'
      checkpoint?: JobCheckpoint | null
    }
  | {
      action: 'resume_empty'
      targetPageId: string
      existingPage: IndexedDatabasePage
      checkpoint?: JobCheckpoint | null
    }
  | {
      action: 'resume_partial'
      targetPageId: string
      existingPage: IndexedDatabasePage
      existingTree: NotionBlockTree
      checkpoint: JobCheckpoint
    }
  | {
      action: 'duplicate_exists'
      existingPages: IndexedDatabasePage[]
      primaryPage: IndexedDatabasePage
      existingTree?: NotionBlockTree
      reason: string
    }

export type TranslationJobResult =
  | {
      status: 'skipped_locale'
      sourcePageId: string
      locale: string
      targetPageId?: undefined
    }
  | {
      status: typeof TRANSLATION_STATUS.DRAFT_READY
      sourcePageId: string
      targetPageId: string
      targetPageUrl: string
      translationGroupId: string
      slug: string
      translatedTitle: string
      targetStatus: 'Draft'
      targetLocale: string
      resumed: boolean
      reusedCachedAi: boolean
      validation: StructuralValidationResult
      report: TranslationReport
      dryRun: boolean
    }
  | {
      status: typeof TRANSLATION_STATUS.NEEDS_REVIEW
      sourcePageId: string
      targetPageId: string
      targetPageUrl?: string
      translationGroupId?: string
      slug?: string
      translatedTitle?: string
      targetStatus?: 'Draft'
      targetLocale?: string
      duplicatePrevented?: boolean
      resumed?: boolean
      reusedCachedAi?: boolean
      reason?: string
      validation?: StructuralValidationResult
      report?: TranslationReport
      dryRun?: boolean
    }
  | {
      status: typeof TRANSLATION_STATUS.FAILED
      sourcePageId: string
      targetPageId: string
      error: string
      dryRun: boolean
    }
  | {
      status: 'paused_quota'
      sourcePageId: string
      targetPageId: string
      reason: string
      dryRun: boolean
    }

export interface RecoveredJobSummary {
  sourcePageId: string
  action: 'marked_existing' | 'resumed_partial_job' | 'resumed_empty_shell' | 'reprocessed'
  status: TranslationStatus | 'skipped_locale' | 'paused_quota'
  targetPageId: string
}

export interface PollCycleSummary {
  scannedCount: number
  requestedCount: number
  processedCount: number
  succeededCount: number
  needsReviewCount: number
  failedCount: number
  pausedQuotaCount?: number
  recoveredCount: number
  recoveredJobs: RecoveredJobSummary[]
  results: TranslationJobResult[]
  hasFailures: boolean
}

export type DiscoveredPageParentKind = 'database' | 'page'

export interface DiscoveredReference {
  sourcePageId: string
  blockId: string
  position: string
  referenceKind: 'link_to_page' | 'mention_page' | 'internal_url' | 'relation'
  targetKind: 'page' | 'database' | 'slug'
  targetIdOrSlug: string
  rawHref?: string
}

export interface DiscoveredPageNode {
  pageId: string
  page: NotionPageLike
  meta: PageWorkflowMeta
  parentKind: DiscoveredPageParentKind
  parentDatabaseId: string | null
  parentDataSourceId: string | null
  parentPageId: string | null
  sourceChildPageBlockId: string | null
  depth: number
  blockTree: NotionBlockTree
  childPageIds: string[]
  childDatabaseIds: string[]
  relatedChildPageIds: string[]
  references: DiscoveredReference[]
}

export interface DiscoveredDatabaseNode {
  databaseId: string
  dataSourceInfo: ArticlesDataSourceInfo
  parentPageId: string | null
  sourceBlockId: string | null
  title: string
  isRootDatabase: boolean
  allPages: NotionPageLike[]
  englishPageIds: string[]
  indices: DatabasePageIndices
}

export interface DiscoveredContentGraph {
  rootPageId: string
  rootDatabaseId: string
  pagesById: Map<string, DiscoveredPageNode>
  databasesById: Map<string, DiscoveredDatabaseNode>
  orderedPageIds: string[]
  references: DiscoveredReference[]
}

export interface ResourceMappingEntry {
  sourcePageId: string
  targetPageId: string
  targetLocale: string
  translationGroupId: string
  sourceSlug: string
  targetSlug: string
  sourceTitle: string
  targetTitle: string
  parentKind: DiscoveredPageParentKind
  parentDatabaseId: string | null
  parentTargetPageId: string | null
  updatedAt: string
}

export interface ResourceMappingStoreData {
  version: 1
  mappingsBySourceKey: Record<string, ResourceMappingEntry>
  updatedAt: string
}

export interface ReferenceResolutionMap {
  targetPageIdBySourcePageId: Map<string, string>
  targetSlugBySourceSlug: Map<string, string>
  targetSlugBySourcePageId: Map<string, string>
  translatedDatabaseIds: Set<string>
  localizedPageMetaBySourcePageId: Map<string, PageWorkflowMeta>
}

export interface PlannedPageTask {
  sourcePageId: string
  node: DiscoveredPageNode
  dataSourceInfo: ArticlesDataSourceInfo
  translationGroupId: string
  generatedGroupId: boolean
  existingInspection: ExistingTranslationInspection
  manifest: TranslationManifest
  sourceFingerprint: string
  parentSourcePageId: string | null
}

export interface TranslationPlan {
  rootPageId: string
  targetLocale: string
  graph: DiscoveredContentGraph
  tasksById: Map<string, PlannedPageTask>
  orderedTaskIds: string[]
  referenceMap: ReferenceResolutionMap
  totalDiscoveredPages: number
  totalNestedDatabases: number
  totalTranslatableBlocks: number
}

export interface ChildJobOutcome {
  sourcePageId: string
  title: string
  parentKind: DiscoveredPageParentKind
  status: TranslationStatus | 'skipped_locale' | 'paused_quota'
  targetPageId: string
  error?: string
}

export interface SegmentCacheEntry {
  translatedText: string
  targetLocale: string
  updatedAt: string
}

export interface SegmentCacheStoreData {
  version: 1
  entries: Record<string, SegmentCacheEntry>
  updatedAt: string
}

export interface HierarchicalJobProgress {
  rootPageId: string
  discoveredCount: number
  completedCount: number
  failedCount: number
  needsReviewCount: number
  currentResourceTitle: string
  currentResourceId: string
  outcomes: ChildJobOutcome[]
}

export type {
  BlockObjectRequest,
  BlockObjectResponse,
  Client,
  PageObjectResponse,
  RichTextItemResponse,
}

