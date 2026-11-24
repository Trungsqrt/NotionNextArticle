import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isEditableTarget,
  isInsideDialog,
  shouldIgnoreStudyShortcut,
  shouldYieldToFocusedControl,
} from '../../lib/study/keyboard'

interface MockElementOptions {
  tagName: string
  isContentEditable?: boolean
  role?: string
  matchedSelectors?: string[]
  closestMap?: Record<string, MockElement | null>
}

interface MockElement {
  tagName: string
  isContentEditable: boolean
  getAttribute: (name: string) => string | null
  matches: (selector: string) => boolean
  closest: (selector: string) => MockElement | null
}

function makeEl(opts: MockElementOptions): MockElement {
  const matched = new Set(opts.matchedSelectors || [])
  const closestMap = opts.closestMap || {}
  const el: MockElement = {
    tagName: opts.tagName,
    isContentEditable: Boolean(opts.isContentEditable),
    getAttribute(name: string) {
      if (name === 'role') return opts.role ?? null
      return null
    },
    matches(selector: string) {
      return matched.has(selector)
    },
    closest(selector: string) {
      if (selector in closestMap) return closestMap[selector]
      for (const [key, val] of Object.entries(closestMap)) {
        if (selector.includes(key)) return val
      }
      return null
    },
  }
  return el
}

test('shouldIgnoreStudyShortcut ignores repeat, defaultPrevented, IME composition, and modifiers', () => {
  assert.equal(shouldIgnoreStudyShortcut({ key: 'Enter' }), false)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'Enter', repeat: true }), true)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'ArrowRight', defaultPrevented: true }), true)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'Enter', isComposing: true }), true)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'Enter', keyCode: 229 }), true)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'ArrowLeft', altKey: true }), true)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'ArrowLeft', metaKey: true }), true)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'Enter', ctrlKey: true }), true)
  assert.equal(shouldIgnoreStudyShortcut({ key: 'ArrowRight', shiftKey: true }), true)
})

test('isEditableTarget detects form inputs, contentEditable, and ARIA textbox roles', () => {
  assert.equal(isEditableTarget(makeEl({ tagName: 'INPUT' }) as unknown as EventTarget), true)
  assert.equal(isEditableTarget(makeEl({ tagName: 'TEXTAREA' }) as unknown as EventTarget), true)
  assert.equal(isEditableTarget(makeEl({ tagName: 'SELECT' }) as unknown as EventTarget), true)
  assert.equal(
    isEditableTarget(makeEl({ tagName: 'DIV', isContentEditable: true }) as unknown as EventTarget),
    true
  )
  assert.equal(
    isEditableTarget(makeEl({ tagName: 'DIV', role: 'textbox' }) as unknown as EventTarget),
    true
  )
  assert.equal(isEditableTarget(makeEl({ tagName: 'BODY' }) as unknown as EventTarget), false)
  assert.equal(isEditableTarget(null), false)
})

test('isInsideDialog ignores events originating inside dialog or aria-modal containers', () => {
  const dialog = makeEl({ tagName: 'DIALOG' })
  const childInDialog = makeEl({
    tagName: 'DIV',
    closestMap: { dialog: dialog },
  })
  assert.equal(isInsideDialog(childInDialog as unknown as EventTarget), true)
  assert.equal(
    shouldIgnoreStudyShortcut({ key: 'Enter', target: childInDialog as unknown as EventTarget }),
    true
  )
  assert.equal(isInsideDialog(makeEl({ tagName: 'MAIN' }) as unknown as EventTarget), false)
})

test('shouldYieldToFocusedControl respects keyboard-focused buttons, links, and arrow widgets', () => {
  // Keyboard-focused button (:focus-visible) yields on Enter and Space
  const kbButton = makeEl({
    tagName: 'BUTTON',
    matchedSelectors: [':focus-visible'],
  })
  kbButton.closest = (sel: string) => (sel.includes('button') ? kbButton : null)
  assert.equal(shouldYieldToFocusedControl(kbButton as unknown as EventTarget, 'Enter'), true)
  assert.equal(shouldYieldToFocusedControl(kbButton as unknown as EventTarget, ' '), true)
  assert.equal(shouldYieldToFocusedControl(kbButton as unknown as EventTarget, 'ArrowRight'), false)

  // Mouse-clicked button (not :focus-visible) allows Study Room Enter/Space shortcuts
  const mouseButton = makeEl({ tagName: 'BUTTON' })
  mouseButton.closest = (sel: string) => (sel.includes('button') ? mouseButton : null)
  assert.equal(shouldYieldToFocusedControl(mouseButton as unknown as EventTarget, 'Enter'), false)
  assert.equal(shouldYieldToFocusedControl(mouseButton as unknown as EventTarget, ' '), false)

  // Link always yields on Enter
  const link = makeEl({ tagName: 'A' })
  link.closest = (sel: string) => (sel.includes('a[href]') ? link : null)
  assert.equal(shouldYieldToFocusedControl(link as unknown as EventTarget, 'Enter'), true)

  // Tablist yields on ArrowLeft / ArrowRight
  const tablistChild = makeEl({
    tagName: 'BUTTON',
    closestMap: { 'role="tablist"': makeEl({ tagName: 'DIV', role: 'tablist' }) },
  })
  assert.equal(
    shouldYieldToFocusedControl(tablistChild as unknown as EventTarget, 'ArrowLeft'),
    true
  )
  assert.equal(
    shouldYieldToFocusedControl(tablistChild as unknown as EventTarget, 'ArrowRight'),
    true
  )
})
