import { describe, expect, test } from 'claude-code/testing'

import type { Override, SessionInfo, WindowState } from '../types'
import { currentKey, flatten, reconcile } from './expand'
import { parseRoadmap } from './roadmap'
import { IDLE_MS, placeWindow, scrollWindow, tickWindow } from './window'

const ROADMAP = [
  '- [x] P0',
  '  - [x] spec',
  '- [x] P1',
  '  - [x] base',
  '- [x] P1b',
  '- [x] P1c',
  '- P2: Settings',
  '  - [x] UI',
  '  - [~] User tab',
  '  - [ ] Import',
  '- [ ] P3',
  '  - [ ] login',
].join('\n')

const keysOf = (rows: ReturnType<typeof flatten>) => rows.map(r => r.key)
const opts = (overrides: Record<string, Override> = {}, sessions: SessionInfo[] = []) => ({ overrides, sessions, selfId: 'me', current: undefined as string | undefined })

describe('defaults and folding', () => {
  test('only the branch in progress is open; a run of done items folds', () => {
    const { nodes } = parseRoadmap(ROADMAP)
    const o = opts()
    o.current = currentKey(nodes, [], 'me')
    expect(o.current).toBe('p2-settings/user-tab')
    expect(keysOf(flatten(nodes, o))).toEqual(['fold:p0', 'p2-settings', 'p2-settings/ui', 'p2-settings/user-tab', 'p2-settings/import', 'p3'])
  })

  test('an open fold shows its items; a manually opened done item stays out of the fold', () => {
    const { nodes } = parseRoadmap(ROADMAP)
    const unfolded = flatten(nodes, opts({ 'fold:p0': { open: true, status: 'done' } }))
    expect(keysOf(unfolded).slice(0, 5)).toEqual(['fold:p0', 'p0', 'p1', 'p1b', 'p1c'])

    const opened = flatten(nodes, opts({ p1: { open: true, status: 'done' } }))
    expect(keysOf(opened).slice(0, 5)).toEqual(['p0', 'p1', 'p1/base', 'p1b', 'p1c'])
  })

  test('a session claim opens its item and shows a session row', () => {
    const { nodes } = parseRoadmap(ROADMAP)
    const s: SessionInfo = { sessionId: 'other', title: 'T', itemKey: 'p3/login', state: 'working', updatedAt: 1 }
    const rows = flatten(nodes, { ...opts({}, [s]), current: currentKey(nodes, [s], 'me') })
    expect(keysOf(rows)).toContain('p3/login')
    expect(keysOf(rows)[keysOf(rows).indexOf('p3/login') + 1]).toBe('session:other')
  })

  test('next up is current when nothing is in progress', () => {
    const { nodes } = parseRoadmap('- [x] a\n- [ ] b\n  - [ ] b1\n- [ ] c')
    expect(currentKey(nodes, [], 'me')).toBe('b/b1')
  })
})

describe('reconcile: auto-collapse on completion', () => {
  test('a section that becomes done loses its override and collapses', () => {
    const before = parseRoadmap('- [~] P2\n  - [ ] a').nodes
    const ov = { p2: { open: true, status: 'doing' as const } }
    expect(reconcile(ov, before).changed).toBe(false)
    const after = parseRoadmap('- [x] P2\n  - [x] a').nodes
    const r = reconcile(ov, after)
    expect(r.changed).toBe(true)
    expect(r.overrides).toEqual({})
    expect(keysOf(flatten(after, opts(r.overrides)))).toEqual(['p2'])
  })

  test('a done item the person opened stays open across refreshes', () => {
    const nodes = parseRoadmap('- [x] P1\n  - [x] a\n- [~] P2\n  - [ ] b').nodes
    const ov = { p1: { open: true, status: 'done' as const } }
    const r = reconcile(ov, nodes)
    expect(r.changed).toBe(false)
    expect(keysOf(flatten(nodes, opts(r.overrides)))).toContain('p1/a')
  })

  test('a todo item the person opened stays open', () => {
    const nodes = parseRoadmap('- [ ] P3\n  - [ ] a').nodes
    expect(reconcile({ p3: { open: true, status: 'todo' } }, nodes).changed).toBe(false)
  })

  test('an item that disappears drops its override', () => {
    expect(reconcile({ gone: { open: true, status: 'todo' } }, []).overrides).toEqual({})
  })
})

describe('window', () => {
  const w0: WindowState = { start: 0, follow: true, lastInteract: 0 }

  test('200 rows: the current item is in view and at most the window is drawn', () => {
    const start = placeWindow(200, 150, 18, w0)
    expect(150 >= start && 150 < start + 18).toBe(true)
    expect(start).toBe(144)
  })

  test('following keeps the window still while the current item is in view', () => {
    expect(placeWindow(200, 150, 18, { ...w0, start: 140 })).toBe(140)
    expect(placeWindow(200, 157, 18, { ...w0, start: 140 })).toBe(151)
  })

  test('scrolling away stops following; scrolling back resumes it', () => {
    const away = scrollWindow(200, 150, 18, w0, -60, 1000)
    expect(away.follow).toBe(false)
    expect(placeWindow(200, 150, 18, away)).toBe(84)
    const back = scrollWindow(200, 150, 18, away, 60, 2000)
    expect(back.follow).toBe(true)
  })

  test('a minute without interaction resumes following', () => {
    const away = { start: 0, follow: false, lastInteract: 1000 }
    expect(tickWindow(away, 1000 + IDLE_MS - 1).follow).toBe(false)
    expect(tickWindow(away, 1000 + IDLE_MS).follow).toBe(true)
  })

  test('a short list never scrolls', () => {
    expect(placeWindow(10, 9, 18, { ...w0, start: 5 })).toBe(0)
  })
})
