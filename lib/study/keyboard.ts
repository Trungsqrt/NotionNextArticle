/**
 * lib/study/keyboard.ts — Lightweight keyboard shortcut guards for Study Room
 * ────────────────────────────────────────────────────────────────────────────
 * Pure guards to ensure Study Room shortcuts respect editable fields, dialogs,
 * IME composition, key repeat, modifier keys, and native focused controls.
 */

export interface ElementLike {
  tagName: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
  matches?: (selector: string) => boolean
  closest?: (selector: string) => ElementLike | null
}

export interface KeyboardEventLike {
  key: string
  repeat?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
  keyCode?: number
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target?: unknown
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

const EDITABLE_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'searchbox'])

const INTERACTIVE_SELECTOR =
  'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"]'

const STUDY_OPTION_SELECTOR = '[data-study-option="true"]'

const ARROW_CONTROL_SELECTOR =
  '[role="radiogroup"], [role="tablist"], [role="slider"], [role="menu"], [role="listbox"]'

const DIALOG_SELECTOR =
  'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'

const OPEN_DIALOG_SELECTOR =
  'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'

function isElementLike(target: unknown): target is ElementLike {
  return Boolean(
    target &&
      typeof target === 'object' &&
      'tagName' in target &&
      typeof (target as ElementLike).tagName === 'string'
  )
}

function matchesSafe(el: ElementLike, selector: string): boolean {
  try {
    return typeof el.matches === 'function' && el.matches(selector)
  } catch {
    return false
  }
}

function closestSafe(el: ElementLike, selector: string): ElementLike | null {
  try {
    return typeof el.closest === 'function' ? el.closest(selector) : null
  } catch {
    return null
  }
}

function hasOpenModalDialog(): boolean {
  const doc = (globalThis as { document?: { querySelector?: (sel: string) => unknown } })
    .document
  if (!doc || typeof doc.querySelector !== 'function') return false
  try {
    return Boolean(doc.querySelector(OPEN_DIALOG_SELECTOR))
  } catch {
    return false
  }
}

export function isEditableTarget(target: unknown): boolean {
  if (!isElementLike(target)) return false
  if (EDITABLE_TAGS.has(target.tagName.toUpperCase())) return true
  if (target.isContentEditable) return true
  const role = target.getAttribute?.('role')?.toLowerCase()
  if (role && EDITABLE_ROLES.has(role)) return true
  if (closestSafe(target, '[contenteditable="true"], [contenteditable=""]')) return true
  return false
}

export function isInsideDialog(target: unknown): boolean {
  if (isElementLike(target) && closestSafe(target, DIALOG_SELECTOR)) {
    return true
  }
  return hasOpenModalDialog()
}

/**
 * Returns true if the focused target should handle this key natively rather than
 * triggering a page-level Study Room shortcut.
 */
export function shouldYieldToFocusedControl(target: unknown, key: string): boolean {
  if (!isElementLike(target)) return false

  if (key === 'Enter' || key === ' ') {
    const interactive = closestSafe(target, INTERACTIVE_SELECTOR)
    if (!interactive) return false

    // Always let links handle Enter natively
    if (key === 'Enter' && interactive.tagName.toUpperCase() === 'A') {
      return true
    }

    // Allow Smart Enter on focused answer option buttons so Enter triggers
    // Check Answer / Next / Finish Practice instead of toggling the option,
    // while keeping Space available for native keyboard option selection.
    if (key === 'Enter' && matchesSafe(interactive, STUDY_OPTION_SELECTOR)) {
      return false
    }

    // Yield when the control is keyboard-focused (:focus-visible) so Tab + Enter/Space
    // activates the focused control natively, while mouse-clicked option buttons don't
    // block Study Room Enter/Space shortcuts.
    if (matchesSafe(interactive, ':focus-visible')) {
      return true
    }
  }

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (closestSafe(target, ARROW_CONTROL_SELECTOR)) {
      return true
    }
  }

  return false
}

/**
 * Master guard for Study Room keyboard shortcuts.
 * Returns true when the event should be ignored by page-level shortcut handlers.
 */
export function shouldIgnoreStudyShortcut(event: KeyboardEventLike): boolean {
  if (event.defaultPrevented) return true
  if (event.repeat) return true
  if (event.isComposing || event.keyCode === 229) return true
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true
  if (isEditableTarget(event.target)) return true
  if (isInsideDialog(event.target)) return true
  if (shouldYieldToFocusedControl(event.target, event.key)) return true
  return false
}
