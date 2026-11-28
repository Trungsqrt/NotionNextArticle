/**
 * lib/notion-translation/builder.ts — Public Translation Worker Builder entry point
 * ─────────────────────────────────────────────────────────────────────────────────
 * Preserves all public exports while delegating to cohesive modules under
 * `lib/notion-translation/builder/`:
 *   - `rich-text.ts`       — rich-text reconstruction, URL localization, Mermaid & 2000-char chunking
 *   - `block-tree.ts`      — translated Notion block tree assembly (`buildTranslatedBlockTree`)
 *   - `page-properties.ts` — Vietnamese slug generation & Notion page property payloads
 */

export {
  sanitizeAnnotations,
  localizeInternalUrl,
  rebuildMermaidCode,
  chunkTextContent,
  rebuildRichTextArray,
  toNotionRichTextRequest,
  type RebuiltRichTextItem,
} from './builder/rich-text'

export { buildTranslatedBlockTree } from './builder/block-tree'

export {
  generateVietnameseSlug,
  resolveUniqueVietnameseSlug,
  buildTranslatedPageProperties,
  type BuildTranslatedPagePropertiesOptions,
} from './builder/page-properties'
