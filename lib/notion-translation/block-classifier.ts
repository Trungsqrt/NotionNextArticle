import type {
  BlockClassification,
  RichTextClassification,
} from './types'

export const BLOCK_RULES: Readonly<Record<string, BlockClassification>> =
  Object.freeze({
    paragraph: {
      type: 'paragraph',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color', 'icon'],
      canHaveChildren: true,
    },
    heading_1: {
      type: 'heading_1',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color', 'is_toggleable'],
      canHaveChildren: true,
    },
    heading_2: {
      type: 'heading_2',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color', 'is_toggleable'],
      canHaveChildren: true,
    },
    heading_3: {
      type: 'heading_3',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color', 'is_toggleable'],
      canHaveChildren: true,
    },
    heading_4: {
      type: 'heading_4',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color', 'is_toggleable'],
      canHaveChildren: true,
    },
    heading_5: {
      type: 'heading_5',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color', 'is_toggleable'],
      canHaveChildren: true,
    },
    heading_6: {
      type: 'heading_6',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color', 'is_toggleable'],
      canHaveChildren: true,
    },
    bulleted_list_item: {
      type: 'bulleted_list_item',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color'],
      canHaveChildren: true,
    },
    numbered_list_item: {
      type: 'numbered_list_item',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color'],
      canHaveChildren: true,
    },
    to_do: {
      type: 'to_do',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['checked', 'color'],
      canHaveChildren: true,
    },
    quote: {
      type: 'quote',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color'],
      canHaveChildren: true,
    },
    callout: {
      type: 'callout',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['icon', 'color'],
      canHaveChildren: true,
    },
    toggle: {
      type: 'toggle',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: ['color'],
      canHaveChildren: true,
    },
    template: {
      type: 'template',
      supported: true,
      category: 'translatable_text',
      translatableFields: ['rich_text'],
      preserveFields: [],
      canHaveChildren: true,
    },
    table: {
      type: 'table',
      supported: true,
      category: 'container',
      translatableFields: [],
      preserveFields: ['table_width', 'has_column_header', 'has_row_header'],
      canHaveChildren: true,
    },
    table_row: {
      type: 'table_row',
      supported: true,
      category: 'translatable_cells',
      translatableFields: ['cells'],
      preserveFields: [],
      canHaveChildren: false,
    },
    column_list: {
      type: 'column_list',
      supported: true,
      category: 'container',
      translatableFields: [],
      preserveFields: [],
      canHaveChildren: true,
    },
    column: {
      type: 'column',
      supported: true,
      category: 'container',
      translatableFields: [],
      preserveFields: ['width_ratio'],
      canHaveChildren: true,
    },
    image: {
      type: 'image',
      supported: true,
      category: 'media',
      translatableFields: ['caption'],
      preserveFields: ['type', 'external', 'file', 'file_upload'],
      canHaveChildren: false,
    },
    video: {
      type: 'video',
      supported: true,
      category: 'media',
      translatableFields: ['caption'],
      preserveFields: ['type', 'external', 'file', 'file_upload'],
      canHaveChildren: false,
    },
    file: {
      type: 'file',
      supported: true,
      category: 'media',
      translatableFields: ['caption'],
      preserveFields: ['type', 'external', 'file', 'file_upload', 'name'],
      canHaveChildren: false,
    },
    pdf: {
      type: 'pdf',
      supported: true,
      category: 'media',
      translatableFields: ['caption'],
      preserveFields: ['type', 'external', 'file', 'file_upload'],
      canHaveChildren: false,
    },
    audio: {
      type: 'audio',
      supported: true,
      category: 'media',
      translatableFields: ['caption'],
      preserveFields: ['type', 'external', 'file', 'file_upload'],
      canHaveChildren: false,
    },
    bookmark: {
      type: 'bookmark',
      supported: true,
      category: 'link_media',
      translatableFields: ['caption'],
      preserveFields: ['url'],
      canHaveChildren: false,
    },
    embed: {
      type: 'embed',
      supported: true,
      category: 'link_media',
      translatableFields: [],
      preserveFields: ['url', 'caption'],
      canHaveChildren: false,
    },
    code: {
      type: 'code',
      supported: true,
      category: 'non_translatable',
      translatableFields: ['caption'], // NEVER translate code body directly; captions and safe Mermaid display labels are handled explicitly
      preserveFields: ['rich_text', 'language', 'caption'],
      canHaveChildren: false,
    },
    equation: {
      type: 'equation',
      supported: true,
      category: 'non_translatable',
      translatableFields: [], // NEVER translate mathematical expressions
      preserveFields: ['expression'],
      canHaveChildren: false,
    },
    divider: {
      type: 'divider',
      supported: true,
      category: 'non_translatable',
      translatableFields: [],
      preserveFields: [],
      canHaveChildren: false,
    },
    breadcrumb: {
      type: 'breadcrumb',
      supported: true,
      category: 'non_translatable',
      translatableFields: [],
      preserveFields: [],
      canHaveChildren: false,
    },
    table_of_contents: {
      type: 'table_of_contents',
      supported: true,
      category: 'non_translatable',
      translatableFields: [],
      preserveFields: ['color'],
      canHaveChildren: false,
    },
    synced_block: {
      type: 'synced_block',
      supported: true,
      category: 'special_synced',
      translatableFields: [],
      preserveFields: ['synced_from'],
      canHaveChildren: true,
      requiresManualReviewNote: true,
    },
    child_page: {
      type: 'child_page',
      supported: true,
      category: 'linked_resource',
      resourceType: 'page',
      translatableFields: [],
      preserveFields: ['title'],
      canHaveChildren: false,
      requiresManualReviewNote: true,
    },
    child_database: {
      type: 'child_database',
      supported: true,
      category: 'linked_resource',
      resourceType: 'database',
      translatableFields: [],
      preserveFields: ['title'],
      canHaveChildren: false,
      requiresManualReviewNote: true,
    },
    link_to_page: {
      type: 'link_to_page',
      supported: true,
      category: 'linked_resource',
      resourceType: 'link_to_page',
      translatableFields: [],
      preserveFields: ['type', 'page_id', 'database_id', 'comment_id'],
      canHaveChildren: false,
    },
  })

export function isSliderToggleBlock(rawBlock: unknown): boolean {
  if (!rawBlock || typeof rawBlock !== 'object') return false
  const candidate = rawBlock as { raw?: unknown; type?: string; toggle?: { rich_text?: unknown[] } }
  const block = (candidate.raw && typeof candidate.raw === 'object'
    ? candidate.raw
    : candidate) as { type?: string; toggle?: { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> } }

  if (block?.type !== 'toggle') return false
  const richText = block.toggle?.rich_text || []
  const plain = richText
    .map((r) => r?.plain_text ?? r?.text?.content ?? '')
    .join('')
    .trim()
  return plain === '[slider]'
}

export function classifyBlock(blockNodeOrRaw: unknown): BlockClassification {
  const obj = (blockNodeOrRaw && typeof blockNodeOrRaw === 'object'
    ? blockNodeOrRaw
    : {}) as { raw?: Record<string, unknown>; type?: string; has_children?: boolean }
  const raw = (obj.raw && typeof obj.raw === 'object' ? obj.raw : obj) as Record<
    string,
    unknown
  >
  const type = String(obj.type || raw.type || 'unsupported')
  const baseRule = BLOCK_RULES[type]

  if (!baseRule || type === 'unsupported') {
    return {
      type,
      supported: false,
      category: 'unsupported',
      translatableFields: [],
      preserveFields: [],
      canHaveChildren: Boolean(raw.has_children),
      requiresManualReviewNote: true,
    }
  }

  if (type === 'toggle' && isSliderToggleBlock(raw)) {
    return {
      ...baseRule,
      isCustomSliderToggle: true,
      translatableFields: [],
    }
  }

  if (type === 'code') {
    const codePayload = raw.code as { language?: string } | undefined
    const lang = String(codePayload?.language || '')
      .trim()
      .toLowerCase()
    if (lang === 'mermaid') {
      return {
        ...baseRule,
        isMermaidCodeBlock: true,
      }
    }
  }

  return { ...baseRule }
}

/**
 * Determines whether a single rich_text run is human-translatable text or
 * must be preserved verbatim (inline code, inline equation, mention, or pure punctuation/whitespace).
 */
export function classifyRichTextRun(run: unknown): RichTextClassification {
  if (!run || typeof run !== 'object') {
    return { translatable: false, reason: 'invalid_run' }
  }

  const r = run as {
    type?: string
    equation?: unknown
    mention?: unknown
    annotations?: { code?: boolean }
    text?: { content?: string }
    plain_text?: string
  }

  const runType =
    r.type || (r.equation ? 'equation' : r.mention ? 'mention' : 'text')

  if (runType === 'equation') {
    return { translatable: false, reason: 'inline_equation' }
  }
  if (runType === 'mention') {
    return { translatable: false, reason: 'mention' }
  }
  if (r.annotations?.code === true) {
    return { translatable: false, reason: 'inline_code' }
  }

  const text = r.text?.content ?? r.plain_text ?? ''
  if (!text || !text.trim()) {
    return { translatable: false, reason: 'whitespace_only' }
  }

  if (!/\p{L}/u.test(text)) {
    return { translatable: false, reason: 'non_lexical' }
  }

  return { translatable: true, reason: 'human_text' }
}

