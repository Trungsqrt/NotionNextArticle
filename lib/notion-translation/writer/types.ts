import type { Client } from '@notionhq/client'
import type { NotionOperationOptions } from '../notion-client'
import type {
  ArticlesDataSourceInfo,
  CheckpointController,
  DiscoveredPageParentKind,
  LinkedResourceIssue,
  MissingMediaIssue,
  NotionBlockNode,
  NotionPageLike,
  NotionRawBlock,
  PageWorkflowMeta,
  RetryConfigOptions,
  SyncedBlockIssue,
  TranslatedPagePropertiesPayload,
  UnsupportedBlockIssue,
  WorkerLogger,
  WriterStats,
} from '../types'

export interface AmbiguousReconciliationError extends Error {
  code: 'AMBIGUOUS_APPEND_RECONCILIATION'
  needsReview: true
  details: Record<string, unknown>
}

export interface AssetWriteOptions extends NotionOperationOptions {
  checkpoint?: CheckpointController | null
}

export interface ColumnFollowUp {
  columnIndex: number
  firstChildSourceId?: string
  firstChildInlineCount?: number
  firstChildDeferredChildren: NotionBlockNode[]
  initialColumnChildCount: number
  remainingColumnChildren: NotionBlockNode[]
}

export interface BuiltSingleBlockResult {
  request: Record<string, unknown> | null
  deferredChildren: NotionBlockNode[]
  inlineCreatedCount?: number
  columnFollowUps?: ColumnFollowUp[]
}

export interface ChildPageWriteRequest {
  sourceChildPageNode: NotionBlockNode
  sourceChildPageId: string
  targetParentPageId: string
  expectedStartIndex: number
  existingTargetBlock: NotionRawBlock | null
}

export interface ChildPageWriteResponse {
  targetChildPageId: string
  title?: string
}

export interface BlockWriteContext {
  client: Client
  missingMedia: MissingMediaIssue[]
  unsupportedBlocks: UnsupportedBlockIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
  localizedPageMap?: Map<string, PageWorkflowMeta>
  translatedDatabaseIds?: Set<string>
  onWriteChildPage?: (
    params: ChildPageWriteRequest
  ) => Promise<ChildPageWriteResponse | null>
  maxBlocksPerAppend: number
  depth: number
  parentKey?: string
  initialExistingChildCount?: number
  isResuming?: boolean
  checkpoint?: CheckpointController | null
  stats: WriterStats
  logger: WorkerLogger
  retryOptions?: RetryConfigOptions
  options: AssetWriteOptions
}

export interface PreparedBlockDescriptor extends BuiltSingleBlockResult {
  sourceNode: NotionBlockNode
  request: Record<string, unknown>
}

export interface CreatedTargetPage {
  id: string
  url?: string
  properties?: Record<string, unknown>
}

export interface CreateTranslatedNotionPageOptions extends AssetWriteOptions {
  client?: Client
  dataSourceInfo?: Partial<ArticlesDataSourceInfo> | null
  parentKind?: DiscoveredPageParentKind
  parentTargetPageId?: string | null
  pagePropertiesPayload?:
    | TranslatedPagePropertiesPayload
    | Record<string, unknown>
  onTargetPageCreated?: (targetPage: CreatedTargetPage) => Promise<void> | void
  onWriteChildPage?: (
    params: ChildPageWriteRequest
  ) => Promise<ChildPageWriteResponse | null>
  reconcileCreatedPage?: () => Promise<NotionPageLike | null>
  resumeTargetPageId?: string | null
  isResuming?: boolean
  localizedPageMap?: Map<string, PageWorkflowMeta>
  translatedDatabaseIds?: Set<string>
  maxBlocksPerAppend?: number
}
