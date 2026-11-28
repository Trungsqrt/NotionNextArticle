import type { Client } from '@notionhq/client'
import type { TranslationConfig } from '../config'
import type { NotionOperationOptions } from '../notion-client'
import type {
  AiProviderAdapter,
  ArticlesDataSourceInfo,
  DiscoveredPageParentKind,
  ExistingTranslationInspection,
  JobCheckpoint,
  NotionBlockTree,
  NotionPageLike,
  ReferenceResolutionMap,
  TranslationStatus,
} from '../types'

export interface SourceWorkflowStateUpdates {
  translationStatus?: TranslationStatus | string
  translationError?: string
  translationTargetPageId?: string
  translationUpdatedAt?: string
  translationGroupId?: string
}

export interface InspectExistingTranslationOptions extends NotionOperationOptions {
  checkpoint?: JobCheckpoint | null
  dataSourceInfo?: Partial<ArticlesDataSourceInfo> | null
  allowResumeEmptyShell?: boolean
  allowResumePartial?: boolean
}

export interface ProcessTranslationJobOptions extends InspectExistingTranslationOptions {
  client?: Client
  config?: TranslationConfig
  allDatabasePages?: NotionPageLike[]
  targetLocale?: string
  aiAdapter?: AiProviderAdapter
  batchSize?: number
  maxBatchChars?: number
  concurrency?: number
  maxAiRetries?: number
  maxBlocksPerAppend?: number
  generateUuid?: () => string
  parentKind?: DiscoveredPageParentKind
  parentTargetPageId?: string | null
  referenceMap?: ReferenceResolutionMap | null
  skipHierarchyDiscovery?: boolean
  isChildTask?: boolean
  preloadedSourceTree?: NotionBlockTree | null
  existingCheckOverride?: ExistingTranslationInspection | null
  deferFinalSourceStatusUpdate?: boolean
  onWriteChildPage?: (params: {
    sourceChildPageNode: NotionBlockTree[number]
    sourceChildPageId: string
    targetParentPageId: string
    expectedStartIndex: number
    existingTargetBlock: { id?: string; type?: string } | null
  }) => Promise<{ targetChildPageId: string; title?: string } | null>
}

export interface RecoverStaleJobsOptions extends ProcessTranslationJobOptions {
  staleTimeoutMs?: number
  nowMs?: number
}
