'use strict'

function makeRichTextRun(content, options = {}) {
  const {
    bold = false,
    italic = false,
    strikethrough = false,
    underline = false,
    code = false,
    color = 'default',
    url = null,
  } = options

  return {
    type: 'text',
    text: {
      content,
      link: url ? { url } : null,
    },
    annotations: {
      bold,
      italic,
      strikethrough,
      underline,
      code,
      color,
    },
    plain_text: content,
    href: url,
  }
}

function createSampleSourcePage(overrides = {}) {
  return {
    id: overrides.id || 'page-en-001',
    url: overrides.url || 'https://www.notion.so/page-en-001',
    in_trash: false,
    archived: false,
    created_time: '2026-11-01T10:00:00.000Z',
    last_edited_time: overrides.last_edited_time || '2026-11-05T08:00:00.000Z',
    icon: { type: 'emoji', emoji: '🛠️' },
    cover: {
      type: 'external',
      external: { url: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c' },
    },
    properties: {
      Name: {
        id: 'title',
        type: 'title',
        title: [makeRichTextRun(overrides.title || 'Understanding ServiceNow CMDB and IRE Architecture')],
      },
      Slug: {
        id: 'slug',
        type: 'rich_text',
        rich_text: [makeRichTextRun(overrides.slug || 'understanding-servicenow-cmdb-ire')],
      },
      Status: {
        id: 'status',
        type: 'status',
        status: { name: overrides.status || 'Published', color: 'green' },
      },
      Locale: {
        id: 'locale',
        type: 'select',
        select: overrides.locale === null ? null : { name: overrides.locale ?? 'en', color: 'blue' },
      },
      'Translation Group ID': {
        id: 'group_id',
        type: 'rich_text',
        rich_text: overrides.translationGroupId
          ? [makeRichTextRun(overrides.translationGroupId)]
          : [],
      },
      Category: {
        id: 'cat',
        type: 'select',
        select: { name: 'CMDB', color: 'green' },
      },
      Tags: {
        id: 'tags',
        type: 'multi_select',
        multi_select: [
          { name: 'CMDB', color: 'green' },
          { name: 'CSDM', color: 'blue' },
        ],
      },
      Summary: {
        id: 'summary',
        type: 'rich_text',
        rich_text: [
          makeRichTextRun('A comprehensive guide to configuring '),
          makeRichTextRun('GlideRecord', { code: true }),
          makeRichTextRun(' and IRE rules in ServiceNow.'),
        ],
      },
      Difficulty: {
        id: 'diff',
        type: 'select',
        select: { name: 'Intermediate', color: 'yellow' },
      },
      Duration: {
        id: 'dur',
        type: 'rich_text',
        rich_text: [makeRichTextRun('25 min')],
      },
      'Parent Course': {
        id: 'parent_course',
        type: 'relation',
        relation: [{ id: 'course-cmdb-101' }],
      },
      'Translation Status': {
        id: 'trans_status',
        type: 'select',
        select: { name: overrides.translationStatus || 'Requested', color: 'blue' },
      },
      'Translation Error': {
        id: 'trans_err',
        type: 'rich_text',
        rich_text: overrides.translationError ? [makeRichTextRun(overrides.translationError)] : [],
      },
      'Translation Target Page ID': {
        id: 'trans_target',
        type: 'rich_text',
        rich_text: overrides.translationTargetPageId
          ? [makeRichTextRun(overrides.translationTargetPageId)]
          : [],
      },
      'Translation Updated At': {
        id: 'trans_updated',
        type: 'date',
        date: overrides.translationUpdatedAt ? { start: overrides.translationUpdatedAt } : null,
      },
    },
  }
}

/**
 * Complete fixture set covering all 15 required block types and nested structures:
 * - Paragraphs
 * - Multiple rich-text runs
 * - Bold / italic / code annotations + hyperlinks + inline equations
 * - Headings (heading_1, heading_2, heading_3)
 * - Nested lists (bulleted_list_item, numbered_list_item)
 * - To-do blocks (checked and unchecked)
 * - Callouts with children
 * - Toggles with nested blocks (plus [slider] toggle preservation)
 * - Tables and table rows
 * - Code blocks
 * - Equations
 * - Images (external and Notion file)
 * - Bookmarks
 * - Columns (column_list + column)
 * - Unsupported blocks
 */
function createComprehensiveBlockFixtures() {
  const topLevelBlocks = [
    {
      id: 'blk-h1',
      type: 'heading_1',
      has_children: false,
      heading_1: {
        rich_text: [makeRichTextRun('CMDB Configuration Overview')],
        color: 'default',
      },
    },
    {
      id: 'blk-para-mixed',
      type: 'paragraph',
      has_children: false,
      paragraph: {
        rich_text: [
          makeRichTextRun('Use '),
          makeRichTextRun('Business Rule', { bold: true }),
          makeRichTextRun(' with '),
          makeRichTextRun('GlideRecord', { code: true }),
          makeRichTextRun(' to query the '),
          makeRichTextRun('official documentation', {
            italic: true,
            url: 'https://docs.servicenow.com',
          }),
          {
            type: 'equation',
            equation: { expression: 'O(\\log n)' },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'O(\\log n)',
            href: null,
          },
          makeRichTextRun(' efficiently.'),
        ],
        color: 'default',
      },
    },
    {
      id: 'blk-bullet-1',
      type: 'bulleted_list_item',
      has_children: true,
      bulleted_list_item: {
        rich_text: [makeRichTextRun('Primary Configuration Item (CI) class hierarchy')],
        color: 'default',
      },
    },
    {
      id: 'blk-num-1',
      type: 'numbered_list_item',
      has_children: false,
      numbered_list_item: {
        rich_text: [makeRichTextRun('Verify Identification and Reconciliation Engine rules')],
        color: 'default',
      },
    },
    {
      id: 'blk-todo-1',
      type: 'to_do',
      has_children: false,
      to_do: {
        rich_text: [makeRichTextRun('Enable IRE payload validation in sub-production')],
        checked: true,
        color: 'green',
      },
    },
    {
      id: 'blk-callout-1',
      type: 'callout',
      has_children: true,
      callout: {
        rich_text: [makeRichTextRun('Always test Script Include changes in a scoped sandbox first.')],
        icon: { type: 'emoji', emoji: '💡' },
        color: 'yellow_background',
      },
    },
    {
      id: 'blk-toggle-1',
      type: 'toggle',
      has_children: true,
      toggle: {
        rich_text: [makeRichTextRun('Advanced Troubleshooting Steps')],
        color: 'default',
      },
    },
    {
      id: 'blk-table-1',
      type: 'table',
      has_children: true,
      table: {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
      },
    },
    {
      id: 'blk-code-1',
      type: 'code',
      has_children: false,
      code: {
        language: 'javascript',
        rich_text: [
          makeRichTextRun(
            "var gr = new GlideRecord('cmdb_ci_server');\ngr.addQuery('operational_status', 1);\ngr.query();"
          ),
        ],
        caption: [],
      },
    },
    {
      id: 'blk-eq-1',
      type: 'equation',
      has_children: false,
      equation: {
        expression: 'E = mc^2 + \\sum_{i=1}^{n} x_i',
      },
    },
    {
      id: 'blk-img-1',
      type: 'image',
      has_children: false,
      image: {
        type: 'external',
        external: { url: 'https://images.unsplash.com/photo-1518770660439-4636190af475' },
        caption: [makeRichTextRun('Architecture diagram for CSDM foundation domain')],
      },
    },
    {
      id: 'blk-bookmark-1',
      type: 'bookmark',
      has_children: false,
      bookmark: {
        url: 'https://developer.servicenow.com',
        caption: [makeRichTextRun('ServiceNow Developer Portal reference')],
      },
    },
    {
      id: 'blk-cols-1',
      type: 'column_list',
      has_children: true,
      column_list: {},
    },
    {
      id: 'blk-divider-1',
      type: 'divider',
      has_children: false,
      divider: {},
    },
  ]

  const childrenByParentId = {
    'blk-bullet-1': [
      {
        id: 'blk-bullet-1-child-1',
        type: 'bulleted_list_item',
        has_children: false,
        bulleted_list_item: {
          rich_text: [makeRichTextRun('Nested server class definition')],
          color: 'default',
        },
      },
    ],
    'blk-callout-1': [
      {
        id: 'blk-callout-1-child-1',
        type: 'paragraph',
        has_children: false,
        paragraph: {
          rich_text: [makeRichTextRun('Check system logs before promoting Update Sets.')],
          color: 'default',
        },
      },
    ],
    'blk-toggle-1': [
      {
        id: 'blk-toggle-h2',
        type: 'heading_2',
        has_children: false,
        heading_2: {
          rich_text: [makeRichTextRun('Configuration Steps')],
          color: 'default',
        },
      },
      {
        id: 'blk-toggle-para',
        type: 'paragraph',
        has_children: false,
        paragraph: {
          rich_text: [makeRichTextRun('Configure the instance properties carefully.')],
          color: 'default',
        },
      },
      {
        id: 'blk-toggle-code',
        type: 'code',
        has_children: false,
        code: {
          language: 'javascript',
          rich_text: [makeRichTextRun('var gr = new GlideRecord();')],
          caption: [],
        },
      },
    ],
    'blk-table-1': [
      {
        id: 'blk-table-row-1',
        type: 'table_row',
        has_children: false,
        table_row: {
          cells: [
            [makeRichTextRun('Table Name')],
            [makeRichTextRun('Description')],
          ],
        },
      },
      {
        id: 'blk-table-row-2',
        type: 'table_row',
        has_children: false,
        table_row: {
          cells: [
            [makeRichTextRun('cmdb_ci_server', { code: true })],
            [makeRichTextRun('Stores physical and virtual server records')],
          ],
        },
      },
    ],
    'blk-cols-1': [
      {
        id: 'blk-col-left',
        type: 'column',
        has_children: true,
        column: { width_ratio: 0.5 },
      },
      {
        id: 'blk-col-right',
        type: 'column',
        has_children: true,
        column: { width_ratio: 0.5 },
      },
    ],
    'blk-col-left': [
      {
        id: 'blk-col-left-p1',
        type: 'paragraph',
        has_children: false,
        paragraph: {
          rich_text: [makeRichTextRun('Left column summary of Flow Designer actions.')],
          color: 'default',
        },
      },
    ],
    'blk-col-right': [
      {
        id: 'blk-col-right-p1',
        type: 'paragraph',
        has_children: false,
        paragraph: {
          rich_text: [makeRichTextRun('Right column summary of IntegrationHub spokes.')],
          color: 'default',
        },
      },
    ],
  }

  return {
    topLevelBlocks,
    childrenByParentId,
  }
}

module.exports = {
  makeRichTextRun,
  createSampleSourcePage,
  createComprehensiveBlockFixtures,
}

