/**
 * lib/notion-types.ts — Pure domain types for the Public Knowledge Hub
 * ─────────────────────────────────────────────────────────────────────
 * Type-only module (zero runtime imports). Safe to import via `import type`
 * from both Server Components and `'use client'` components without pulling
 * `@notionhq/client` or server environment variables into client bundles.
 */

import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from '@notionhq/client'

export type NotionRichTextItem = RichTextItemResponse

export interface NotionIconObject {
  type: 'emoji' | 'file' | 'external'
  value?: string
}

export type NotionIcon = NotionIconObject | null

export type NotionPageParent = PageObjectResponse['parent']

export interface NotionSliderImage {
  url: string
  caption: string
  blockId: string | null
}

/**
 * Hydrated block shape produced by `getChildBlocks` and consumed by
 * `renderBlocks` and `<TableOfContents>`.
 */
export type NotionRenderBlock = (
  | BlockObjectResponse
  | {
      id: string
      type: 'custom_slider'
      has_children?: boolean
      images: NotionSliderImage[]
    }
  | {
      id: string
      type: string
      has_children?: boolean
      [key: string]: unknown
    }
) & {
  children?: NotionRenderBlock[]
  database_rows?: PageObjectResponse[]
  page_info?: PageObjectResponse
  images?: NotionSliderImage[]
  list_index?: number
}

export interface NotionArticleSummary {
  id: string
  title: string
  slug: string
  tags: string[]
  category: string
  summary: string
  cover: string | null
  coverIsNotionHosted: boolean
  icon: NotionIcon
  parentTitle: string | null
  parent: NotionPageParent | null
  order: number | null
  status: string
  locale: string
  translationGroupId: string
  date?: string | null
}

export interface NotionArticlePage extends NotionArticleSummary {
  html: string
  blocks: NotionRenderBlock[]
  date: string | null
}

export interface NotionTranslationMeta {
  id: string
  slug: string
  title: string
  summary: string
  icon: NotionIcon
  locale: string
  translationGroupId: string
  date: string | null
}

export type ArticleTranslationsMap = Record<string, NotionTranslationMeta | null>

export interface TranslationMappingEntry {
  rowId: string
  name: string
  enPageId: string
  viPageId: string
  normEnId: string
  normViId: string
  status: string
  isReady: boolean
}

export interface TranslationMappingsResult {
  byEnId: Map<string, TranslationMappingEntry>
  byViId: Map<string, TranslationMappingEntry>
  all: TranslationMappingEntry[]
}

export interface SiblingNavPage {
  id: string
  title: string
  slug: string
  icon: NotionIcon
}

export interface SiblingPagesResult {
  prevPage: SiblingNavPage | null
  nextPage: SiblingNavPage | null
}

export interface RefreshedImageUrl {
  url: string
  expiryTime: string | null
}

export interface NotionImageApiSuccessResponse {
  url: string
  expiresAt?: string
}

export interface NotionApiErrorResponse {
  error: string
}

export type NotionImageApiResponse = NotionImageApiSuccessResponse | NotionApiErrorResponse

export interface NotionChildrenApiSuccessResponse {
  html: string
}

export type NotionChildrenApiResponse = NotionChildrenApiSuccessResponse | NotionApiErrorResponse
