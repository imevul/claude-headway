// Which items are open, which one is "current", and the flat list of rows the pane draws.
import type { Override, RoadmapNode, SessionInfo, Status } from '../types'

import { findByKey, walk } from './roadmap'

export type Row =
  | { kind: 'node'; key: string; depth: number; node: RoadmapNode; open: boolean; canOpen: boolean; isCurrent: boolean }
  | { kind: 'fold'; key: string; depth: number; open: boolean; nodes: RoadmapNode[] }
  | { kind: 'session'; key: string; depth: number; session: SessionInfo; isSelf: boolean }
  | { kind: 'note'; key: string; depth: number; text: string }

export const FOLD_MIN = 3
const isClosedStatus = (s: Status) => s === 'done' || s === 'dropped'

/**
 * The item the pane keeps in view: this session's claim, then another live session's,
 * then the deepest item in progress, then the first item not started ("next up").
 */
export function currentKey(nodes: RoadmapNode[], sessions: SessionInfo[], selfId: string): string | undefined {
  const live = sessions.filter(s => s.state !== 'ended' && s.itemKey && findByKey(nodes, s.itemKey))
  const own = live.find(s => s.sessionId === selfId)
  if (own?.itemKey) return own.itemKey
  if (live[0]?.itemKey) return live[0].itemKey

  for (const [n] of walk(nodes)) {
    if (n.status === 'doing' && !n.children.some(c => c.status === 'doing')) return n.key
  }
  for (const [n] of walk(nodes)) {
    if (!n.isHeading && n.status === 'todo' && !n.children.length) return n.key
  }
  return undefined
}

/** Keys open by default: anything in progress, blocked or claimed, the current item, and their ancestors. */
export function defaultOpenKeys(nodes: RoadmapNode[], claimed: Set<string>, current: string | undefined): Set<string> {
  const open = new Set<string>()
  for (const [n, parents] of walk(nodes)) {
    const hot = n.status === 'doing' || n.status === 'blocked' || claimed.has(n.key) || n.key === current
    if (!hot) continue
    open.add(n.key)
    for (const p of parents) open.add(p.key)
  }
  return open
}

/**
 * Drops overrides that no longer apply: the item is gone, or its status changed since the
 * person toggled it. That is what auto-collapses a section that just got done, while an
 * item the person opened stays open for as long as its status holds.
 */
export function reconcile(
  overrides: Record<string, Override>,
  nodes: RoadmapNode[],
): { overrides: Record<string, Override>; changed: boolean } {
  const next: Record<string, Override> = {}
  let changed = false
  for (const [key, o] of Object.entries(overrides)) {
    const nodeKey = key.startsWith('fold:') ? key.slice(5) : key
    const node = findByKey(nodes, nodeKey)
    const status = node && (key.startsWith('fold:') ? (isClosedStatus(node.status) ? o.status : undefined) : node.status)
    if (status !== undefined && status === o.status) next[key] = o
    else changed = true
  }
  return { overrides: next, changed }
}

export function flatten(
  nodes: RoadmapNode[],
  opts: {
    overrides: Record<string, Override>
    sessions: SessionInfo[]
    selfId: string
    current: string | undefined
  },
): Row[] {
  const bySession = new Map<string, SessionInfo[]>()
  for (const s of opts.sessions) {
    if (s.state === 'ended' || !s.itemKey) continue
    bySession.set(s.itemKey, [...(bySession.get(s.itemKey) ?? []), s])
  }
  const claimed = new Set(bySession.keys())
  const defaults = defaultOpenKeys(nodes, claimed, opts.current)
  const isOpen = (n: RoadmapNode) => opts.overrides[n.key]?.open ?? defaults.has(n.key)
  const rows: Row[] = []

  const emitNode = (n: RoadmapNode, depth: number) => {
    const open = isOpen(n)
    const canOpen = n.children.length > 0 || n.note !== undefined
    rows.push({ kind: 'node', key: n.key, depth, node: n, open: open && canOpen, canOpen, isCurrent: n.key === opts.current })
    for (const s of bySession.get(n.key) ?? []) {
      rows.push({ kind: 'session', key: `session:${s.sessionId}`, depth: depth + 1, session: s, isSelf: s.sessionId === opts.selfId })
    }
    if (!open) return
    if (n.note) rows.push({ kind: 'note', key: `note:${n.key}`, depth: depth + 1, text: n.note })
    emitList(n.children, depth + 1)
  }

  const foldable = (n: RoadmapNode) =>
    isClosedStatus(n.status) && !isOpen(n) && !claimed.has(n.key) && opts.overrides[n.key] === undefined

  const emitList = (list: RoadmapNode[], depth: number) => {
    for (let i = 0; i < list.length; ) {
      let j = i
      while (j < list.length && foldable(list[j]!)) j++
      if (j - i >= FOLD_MIN) {
        const run = list.slice(i, j)
        const key = `fold:${run[0]!.key}`
        const open = opts.overrides[key]?.open ?? false
        rows.push({ kind: 'fold', key, depth, open, nodes: run })
        if (open) for (const n of run) emitNode(n, depth + 1)
        i = j
        continue
      }
      emitNode(list[i]!, depth)
      i++
    }
  }

  emitList(nodes, 0)
  return rows
}
