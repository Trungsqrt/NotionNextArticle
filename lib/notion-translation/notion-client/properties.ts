const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  english: 'en',
  vietnamese: 'vi',
  'tiếng việt': 'vi',
  'tieng viet': 'vi',
}

export function normalizeLocaleCode(
  raw: unknown,
  defaultLocale = 'en'
): string {
  if (raw === null || raw === undefined) return defaultLocale
  const value = String(raw).trim().toLowerCase()
  if (!value) return defaultLocale
  if (LOCALE_ALIASES[value]) return LOCALE_ALIASES[value]
  const primary = value.split(/[-_]/)[0]
  if (primary && /^[a-z]{2,3}$/.test(primary)) return primary
  return defaultLocale
}

export function normalizeNotionId(id: unknown): string {
  return id ? String(id).replace(/-/g, '').trim().toLowerCase() : ''
}

export function normalizePropKey(name: unknown): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

export function findPropertyKey(
  propsOrSchema: Record<string, unknown> | null | undefined,
  candidates: string | readonly string[]
): string | null {
  if (!propsOrSchema || typeof propsOrSchema !== 'object') return null
  const byNorm = new Map<string, string>()
  for (const key of Object.keys(propsOrSchema)) {
    const norm = normalizePropKey(key)
    if (!byNorm.has(norm)) byNorm.set(norm, key)
  }
  const list = Array.isArray(candidates) ? candidates : [candidates]
  for (const candidate of list) {
    const found = byNorm.get(normalizePropKey(candidate))
    if (found) return found
  }
  return null
}

export function findPropertyEntry<T = Record<string, unknown>>(
  propsOrSchema: Record<string, T> | null | undefined,
  candidates: string | readonly string[]
): { key: string | null; prop: T | null } {
  const key = findPropertyKey(propsOrSchema, candidates)
  if (!key || !propsOrSchema) return { key: null, prop: null }
  return { key, prop: propsOrSchema[key] ?? null }
}

export function findTitlePropertyKey(
  propsOrSchema: Record<string, unknown> | null | undefined
): string {
  if (!propsOrSchema || typeof propsOrSchema !== 'object') return 'Name'
  for (const [key, val] of Object.entries(propsOrSchema)) {
    if (val && typeof val === 'object') {
      const record = val as Record<string, unknown>
      if (record.type === 'title' || record.title !== undefined) {
        return key
      }
    }
  }
  return 'Name'
}

export function extractRichTextSegmentPlain(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const r = item as Record<string, unknown>
  if (typeof r.plain_text === 'string') return r.plain_text
  const textObj = r.text as Record<string, unknown> | undefined
  if (typeof textObj?.content === 'string') return textObj.content
  const eqObj = r.equation as Record<string, unknown> | undefined
  if (typeof eqObj?.expression === 'string') return eqObj.expression
  return ''
}

export function getPropertyPlainText(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return ''
  const record = prop as Record<string, unknown>
  const type = record.type

  switch (type) {
    case 'title': {
      const titleArr = Array.isArray(record.title) ? record.title : []
      return titleArr.map(extractRichTextSegmentPlain).join('')
    }
    case 'rich_text': {
      const rtArr = Array.isArray(record.rich_text) ? record.rich_text : []
      return rtArr.map(extractRichTextSegmentPlain).join('')
    }
    case 'select': {
      const sel = record.select as { name?: string } | null | undefined
      return sel?.name || ''
    }
    case 'multi_select': {
      const ms = Array.isArray(record.multi_select) ? record.multi_select : []
      return ms
        .map((item) =>
          item && typeof item === 'object' && 'name' in item
            ? String((item as { name?: unknown }).name || '')
            : ''
        )
        .filter(Boolean)
        .join(', ')
    }
    case 'status': {
      const st = record.status as { name?: string } | null | undefined
      return st?.name || ''
    }
    case 'number':
      return record.number !== undefined && record.number !== null
        ? String(record.number)
        : ''
    case 'date': {
      const dt = record.date as { start?: string } | null | undefined
      return dt?.start || ''
    }
    case 'url':
      return typeof record.url === 'string' ? record.url : ''
    case 'checkbox':
      return typeof record.checkbox === 'boolean'
        ? record.checkbox
          ? 'true'
          : 'false'
        : ''
    case 'email':
      return typeof record.email === 'string' ? record.email : ''
    case 'phone_number':
      return typeof record.phone_number === 'string' ? record.phone_number : ''
    case 'formula': {
      const formula = record.formula as Record<string, unknown> | undefined
      if (!formula) return ''
      if (formula.type === 'string') return String(formula.string || '')
      if (formula.type === 'number')
        return formula.number !== null && formula.number !== undefined
          ? String(formula.number)
          : ''
      if (formula.type === 'boolean') return formula.boolean ? 'true' : 'false'
      if (formula.type === 'date') {
        const fDate = formula.date as { start?: string } | null | undefined
        return fDate?.start || ''
      }
      return ''
    }
    default:
      return ''
  }
}

export function extractDatabaseTitle(
  rawDatabase: unknown,
  rawDataSource: unknown = null,
  fallback = 'Database'
): string {
  const candidates = [rawDatabase, rawDataSource]
  for (const obj of candidates) {
    if (!obj || typeof obj !== 'object') continue
    const rec = obj as { title?: unknown[] }
    if (Array.isArray(rec.title) && rec.title.length > 0) {
      const text = rec.title.map(extractRichTextSegmentPlain).join('').trim()
      if (text) return text
    }
  }
  return fallback
}
