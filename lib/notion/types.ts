/**
 * lib/notion/types.ts — Internal structural Notion SDK & cache types
 * ──────────────────────────────────────────────────────────────────
 * Server-side structural types for raw Notion API responses, cache entries,
 * and globalThis singletons used across `lib/notion/*`.
 * Public domain types live in `lib/notion-types.ts` (client-safe).
 */

import type { NotionSliderImage, RefreshedImageUrl } from '../notion-types'

export interface NotionCacheEntry<T = unknown> {
  timestamp: number
  data: T
}

export interface ImageRefreshCacheEntry {
  url: string
  expiryTime: string | null
  timestamp: number
}

declare global {
  var __notionCache: Map<string, NotionCacheEntry> | undefined
  var __notionI18nWarnings: Set<string> | undefined
  var __notionImageRefreshInFlight: Map<string, Promise<RefreshedImageUrl | null>> | undefined
}

export interface RichTextAnnotationsLike {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  underline?: boolean
  code?: boolean
  color?: string
}

export interface RichTextLike {
  plain_text?: string
  href?: string | null
  annotations?: RichTextAnnotationsLike
}

export interface NotionSelectOptionLike {
  name?: string
  color?: string
}

export interface NotionDateLike {
  start?: string
  end?: string | null
}

export interface NotionFormulaLike {
  type?: string
  string?: string | null
  number?: number | null
  boolean?: boolean | null
  date?: NotionDateLike | null
}

export interface NotionRollupItemLike {
  type?: string
  title?: RichTextLike[]
  rich_text?: RichTextLike[]
  select?: NotionSelectOptionLike | null
  relation?: Array<{ id?: string }>
}

export interface NotionRollupLike {
  type?: string
  array?: NotionRollupItemLike[]
  title?: RichTextLike[]
  rich_text?: RichTextLike[]
}

export interface NotionPropertyLike {
  type?: string
  title?: RichTextLike[]
  rich_text?: RichTextLike[]
  select?: NotionSelectOptionLike | null
  multi_select?: NotionSelectOptionLike[]
  status?: NotionSelectOptionLike | null
  number?: number | null
  date?: NotionDateLike | null
  url?: string | null
  checkbox?: boolean
  email?: string | null
  phone_number?: string | null
  formula?: NotionFormulaLike | null
  rollup?: NotionRollupLike | null
  relation?: Array<{ id?: string }>
  created_time?: string
  last_edited_time?: string
  [key: string]: unknown
}

export type NotionPropertiesMap = Record<string, NotionPropertyLike | undefined>

export interface NotionFileLike {
  url?: string
  expiry_time?: string | null
}

export interface NotionIconLike {
  type?: string
  emoji?: string
  file?: NotionFileLike | null
  external?: { url?: string } | null
}

export interface NotionCoverLike {
  type?: string
  file?: NotionFileLike | null
  external?: { url?: string } | null
}

export interface NotionParentLike {
  type?: string
  database_id?: string
  data_source_id?: string
  page_id?: string
  block_id?: string
  workspace?: boolean
}

export interface NotionPageLike {
  id: string
  archived?: boolean
  in_trash?: boolean
  properties?: NotionPropertiesMap
  cover?: NotionCoverLike | null
  icon?: NotionIconLike | string | null
  parent?: NotionParentLike | null
  created_time?: string
  last_edited_time?: string
}

export interface NotionDatabaseLike {
  id?: string
  archived?: boolean
  in_trash?: boolean
  title?: RichTextLike[]
  data_sources?: Array<{ id?: string }>
  parent?: NotionParentLike | null
}

export interface NotionDataSourceLike {
  id?: string
}

export interface NotionQueryResultLike {
  results?: NotionPageLike[]
  has_more?: boolean
  next_cursor?: string | null
}

export interface NotionSearchResultLike {
  results?: NotionPageLike[]
  has_more?: boolean
  next_cursor?: string | null
}

export interface NotionHeadingPayloadLike {
  rich_text?: RichTextLike[]
  is_toggleable?: boolean
  color?: string
}

export interface NotionBlockLike {
  id: string
  type: string
  has_children?: boolean
  archived?: boolean
  in_trash?: boolean
  parent?: NotionParentLike | null
  children?: NotionBlockLike[]
  database_rows?: NotionPageLike[]
  page_info?: NotionPageLike
  images?: NotionSliderImage[]
  list_index?: number
  icon?: NotionIconLike | null
  child_database?: { title?: string }
  child_page?: { title?: string }
  link_to_page?: { type?: string; database_id?: string; page_id?: string }
  callout?: { icon?: NotionIconLike | null; rich_text?: RichTextLike[]; color?: string }
  heading_1?: NotionHeadingPayloadLike
  heading_2?: NotionHeadingPayloadLike
  heading_3?: NotionHeadingPayloadLike
  heading_4?: NotionHeadingPayloadLike
  heading_5?: NotionHeadingPayloadLike
  heading_6?: NotionHeadingPayloadLike
  image?: {
    type?: string
    file?: NotionFileLike | null
    external?: { url?: string } | null
    caption?: RichTextLike[]
  }
  video?: {
    type?: string
    file?: NotionFileLike | null
    external?: { url?: string } | null
    caption?: RichTextLike[]
  }
  bulleted_list_item?: { rich_text?: RichTextLike[] }
  numbered_list_item?: { rich_text?: RichTextLike[] }
  toggle?: { rich_text?: RichTextLike[]; color?: string }
  paragraph?: { rich_text?: RichTextLike[] }
  quote?: { rich_text?: RichTextLike[] }
  code?: { rich_text?: RichTextLike[]; language?: string; caption?: RichTextLike[] }
  table_row?: { cells?: RichTextLike[][] }
  table?: { has_column_header?: boolean }
  [key: string]: unknown
}

export interface QueryDatabaseOptions extends Record<string, unknown> {
  __ttl?: number
  __isDataSourceId?: boolean
  __databaseId?: string
  page_size?: number
  start_cursor?: string
  sorts?: Array<{ property: string; direction: 'ascending' | 'descending' }>
}
