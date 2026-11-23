import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getStudyRouteLabel,
  isDuplicateStudyNavigation,
  isPlainLeftClick,
  isSameStudyLocation,
  isStudyTabActive,
  resolveStudyTabState,
  splitStudyHref,
} from '../../lib/study/navigation'

test('splitStudyHref separates pathname, query, and strips trailing slash and hash', () => {
  assert.deepEqual(splitStudyHref('/study/practice/?examId=csa-1#top'), {
    pathname: '/study/practice',
    search: 'examId=csa-1',
  })
  assert.deepEqual(splitStudyHref('/study/'), {
    pathname: '/study',
    search: '',
  })
})

test('isStudyTabActive matches Dashboard exactly and sub-tabs by prefix', () => {
  assert.equal(isStudyTabActive('/study', '/study'), true)
  assert.equal(isStudyTabActive('/study/practice', '/study'), false)
  assert.equal(isStudyTabActive('/study/practice', '/study/practice'), true)
  assert.equal(isStudyTabActive('/study/exams/csa-1', '/study/exams'), true)
  assert.equal(isStudyTabActive('/study/exams-other', '/study/exams'), false)
})

test('resolveStudyTabState distinguishes active, active-leaving, pending, and inactive', () => {
  // Idle on Dashboard
  assert.equal(
    resolveStudyTabState({ pathname: '/study', pendingHref: null, tabHref: '/study' }),
    'active'
  )
  assert.equal(
    resolveStudyTabState({ pathname: '/study', pendingHref: null, tabHref: '/study/practice' }),
    'inactive'
  )

  // Navigating from Dashboard -> Practice
  assert.equal(
    resolveStudyTabState({
      pathname: '/study',
      pendingHref: '/study/practice',
      tabHref: '/study/practice',
    }),
    'pending'
  )
  assert.equal(
    resolveStudyTabState({
      pathname: '/study',
      pendingHref: '/study/practice',
      tabHref: '/study',
    }),
    'active-leaving'
  )
  assert.equal(
    resolveStudyTabState({
      pathname: '/study',
      pendingHref: '/study/practice',
      tabHref: '/study/exams',
    }),
    'inactive'
  )

  // Navigating to nested exam detail highlights Mock Exams as pending
  assert.equal(
    resolveStudyTabState({
      pathname: '/study',
      pendingHref: '/study/exams/csa-1',
      tabHref: '/study/exams',
    }),
    'pending'
  )
})

test('isDuplicateStudyNavigation blocks repeated clicks on current or pending route while allowing retargeting', () => {
  // Clicking already active tab without query change -> duplicate
  assert.equal(
    isDuplicateStudyNavigation({
      currentPathname: '/study/practice',
      currentSearch: '',
      pendingHref: null,
      targetHref: '/study/practice',
    }),
    true
  )

  // Clicking Mock Exams tab from a nested exam detail route -> NOT duplicate (returns to list)
  assert.equal(
    isDuplicateStudyNavigation({
      currentPathname: '/study/exams/csa-1',
      currentSearch: '',
      pendingHref: null,
      targetHref: '/study/exams',
    }),
    false
  )

  // Rapid repeated clicks on the same pending tab -> duplicate
  assert.equal(
    isDuplicateStudyNavigation({
      currentPathname: '/study',
      currentSearch: '',
      pendingHref: '/study/practice',
      targetHref: '/study/practice',
    }),
    true
  )

  // Changing mind mid-navigation from Practice -> Active Recall -> NOT duplicate
  assert.equal(
    isDuplicateStudyNavigation({
      currentPathname: '/study',
      currentSearch: '',
      pendingHref: '/study/practice',
      targetHref: '/study/flashcards',
    }),
    false
  )

  // Different query param on same path -> NOT duplicate
  assert.equal(
    isSameStudyLocation('/study/practice', '?examId=csa-1', '/study/practice?examId=csa-2'),
    false
  )
  assert.equal(
    isSameStudyLocation('/study/practice', '?examId=csa-1', '/study/practice?examId=csa-1'),
    true
  )
})

test('getStudyRouteLabel returns human-readable Study Room tab labels', () => {
  assert.equal(getStudyRouteLabel('/study'), 'Dashboard')
  assert.equal(getStudyRouteLabel('/study/flashcards?examId=1'), 'Active Recall')
  assert.equal(getStudyRouteLabel('/study/practice'), 'Practice')
  assert.equal(getStudyRouteLabel('/study/exams/csa-1'), 'Mock Exams')
  assert.equal(getStudyRouteLabel(null), '')
})

test('isPlainLeftClick ignores modified or secondary clicks', () => {
  assert.equal(
    isPlainLeftClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }),
    true
  )
  assert.equal(
    isPlainLeftClick({ button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }),
    false
  )
  assert.equal(
    isPlainLeftClick({ button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }),
    false
  )
  assert.equal(
    isPlainLeftClick({ button: 0, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }),
    false
  )
})
