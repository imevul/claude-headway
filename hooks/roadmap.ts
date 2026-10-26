// Parsing, deriving and editing a roadmap file. Pure functions: no `$`, never throws.
import type { Roadmap, RoadmapNode, Status, Warning } from '../types'

const BULLET = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])(?:[ \t]+(.*))?$/
const BARE_CHECKBOX = /^([ \t]*)(\[[^\]]{0,2}\][ \t]+.*)$/
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const CHECKBOX = /^\[([^\]]{0,2})\][ \t]*/

const BOX_STATUS: Record<string, Status> = {
  '': 'todo', ' ': 'todo',
  x: 'done', X: 'done', '✓': 'done', '✔': 'done', '*': 'done',
  '~': 'doing', '/': 'doing', '-': 'doing', '>': 'doing', '.': 'doing', o: 'doing',
  '!': 'blocked', b: 'blocked', B: 'blocked',
  d: 'dropped', D: 'dropped',
}

// Emoji and tags that carry a status, at either end of a title. Longest first.
const MARKS: [string, Status][] = [
  ['✔️', 'done'], ['☑️', 'done'], ['✅', 'done'], ['✔', 'done'], ['☑', 'done'],
  ['🔁', 'doing'], ['🔄', 'doing'], ['🚧', 'doing'], ['⬅️', 'doing'], ['⬅', 'doing'], ['⏳', 'doing'], ['👉', 'doing'],
  ['❌', 'blocked'], ['⛔', 'blocked'], ['🛑', 'blocked'], ['⚠️', 'blocked'],
]
const TAGS: [RegExp, Status][] = [
  [/^(?:[(\[](?:done|complete|completed|finished)[)\]]\s*|(?:done|complete|completed|finished)\s*[:\-–—]\s*)/i, 'done'],
  [/\s+[(\[](?:done|complete|completed|finished)[)\]]$/i, 'done'],
  [/^(?:[(\[](?:wip|in[ -]progress|doing|current)[)\]]\s*|(?:wip|in[ -]progress|doing|current)\s*[:\-–—]\s*)/i, 'doing'],
  [/\s+[(\[](?:wip|in[ -]progress|doing|current)[)\]]$/i, 'doing'],
  [/^(?:[(\[]blocked[)\]]\s*|blocked\s*[:\-–—]\s*)/i, 'blocked'],
  [/\s+[(\[]blocked[)\]]$/i, 'blocked'],
]

function indentWidth(ws: string): number {
  let n = 0
  for (const ch of ws) n += ch === '\t' ? 4 - (n % 4) : 1
  return n
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Reads the status a title carries (checkbox, emoji, tags, strikethrough) and the title without it. */
export function readMarkers(text: string): { title: string; status?: Status; unknownBox?: string } {
  let rest = text.trim()
  let status: Status | undefined
  let unknownBox: string | undefined

  const box = CHECKBOX.exec(rest)
  if (box) {
    const ch = box[1] ?? ''
    const known = BOX_STATUS[ch] ?? BOX_STATUS[ch.trim()]
    if (known) status = known
    else {
      status = 'todo'
      unknownBox = ch
    }
    rest = rest.slice(box[0].length)
  }

  for (let changed = true; changed; ) {
    changed = false
    for (const [mark, s] of MARKS) {
      if (rest.startsWith(mark)) {
        rest = rest.slice(mark.length).trimStart()
        status ??= s
        changed = true
      }
      if (rest.endsWith(mark)) {
        rest = rest.slice(0, -mark.length).trimEnd()
        status ??= s
        changed = true
      }
    }
    for (const [re, s] of TAGS) {
      const m = re.exec(rest)
      if (m && m[0].length < rest.length) {
        rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim()
        status ??= s
        changed = true
      }
    }
  }

  const struck = /^~~(.+)~~$/.exec(rest)
  if (struck) {
    rest = struck[1] ?? rest
    status = 'dropped'
  }

  return { title: cleanTitle(rest) || '(untitled)', status, unknownBox }
}

export function slug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || 'item'
}

type Draft = RoadmapNode & { indent: number; level: number; noteLines: string[] }

function draft(title: string, status: Status | undefined, line: number, isHeading: boolean, indent: number, level: number): Draft {
  return {
    key: '', title, status: status ?? 'todo', explicit: status !== undefined, isHeading,
    line, children: [], done: 0, total: 0, indent, level, noteLines: [],
  }
}

/** Parses roadmap Markdown into a tree. Anything it can't make sense of becomes a warning, never an error. */
export function parseRoadmap(input: string): Roadmap {
  const warnings: Warning[] = []
  const roots: Draft[] = []
  let title: string | undefined
  const lines = input.replace(/^﻿/, '').split(/\r?\n/)

  const headings: Draft[] = []
  let items: Draft[] = []
  let last: Draft | undefined
  let afterBlank = false
  let fence: string | undefined
  let fenceLine = 0
  let inComment = false

  const attach = (node: Draft, parent: Draft | undefined) => (parent ? parent.children : roots).push(node)

  let i = 0
  if (/^---\s*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l))
    if (end > 0) i = end + 1
  }

  for (; i < lines.length; i++) {
    let raw = lines[i] ?? ''

    if (fence) {
      if (raw.trim().startsWith(fence)) fence = undefined
      continue
    }
    const f = /^\s*(`{3,}|~{3,})/.exec(raw)
    if (f) {
      fence = f[1]
      fenceLine = i
      continue
    }

    if (inComment) {
      const end = raw.indexOf('-->')
      if (end < 0) continue
      raw = raw.slice(end + 3)
      inComment = false
    }
    raw = raw.replace(/<!--.*?-->/g, '')
    const open = raw.indexOf('<!--')
    if (open >= 0) {
      raw = raw.slice(0, open)
      inComment = true
    }

    if (raw.trim() === '') {
      afterBlank = true
      continue
    }

    const h = HEADING.exec(raw)
    if (h) {
      const level = (h[1] ?? '#').length
      const text = h[2] ?? ''
      if (level === 1 && title === undefined && roots.length === 0) {
        title = cleanTitle(readMarkers(text).title)
      } else {
        const { title: t, status, unknownBox } = readMarkers(text)
        if (unknownBox !== undefined) warnings.push({ line: i + 1, message: `Unknown checkbox "[${unknownBox}]", read as todo` })
        while (headings.length && (headings[headings.length - 1]?.level ?? 0) >= level) headings.pop()
        const node = draft(t, status, i, true, -1, level)
        attach(node, headings[headings.length - 1])
        headings.push(node)
        items = []
        last = node
      }
      afterBlank = false
      continue
    }

    if (/^\s*\|/.test(raw) || /^\s*(?:[-=*_]\s*){3,}$/.test(raw) || /^\s*>/.test(raw)) {
      afterBlank = false
      continue
    }

    const b = BULLET.exec(raw) ?? BARE_CHECKBOX.exec(raw)
    if (b) {
      const indent = indentWidth(b[1] ?? '')
      const text = b[2] ?? ''
      if (text.trim() === '') {
        afterBlank = false
        continue
      }
      const { title: t, status, unknownBox } = readMarkers(text)
      if (unknownBox !== undefined) warnings.push({ line: i + 1, message: `Unknown checkbox "[${unknownBox}]", read as todo` })
      while (items.length && (items[items.length - 1]?.indent ?? 0) >= indent) items.pop()
      const node = draft(t, status, i, false, indent, 0)
      attach(node, items[items.length - 1] ?? headings[headings.length - 1])
      items.push(node)
      last = node
      afterBlank = false
      continue
    }

    // Plain text: a note for the item right above it (continuation or indented paragraph).
    const ind = indentWidth(/^[ \t]*/.exec(raw)?.[0] ?? '')
    if (last && !last.isHeading && (!afterBlank || ind > last.indent)) {
      last.noteLines.push(raw.trim())
    }
    afterBlank = false
  }

  if (fence) warnings.push({ line: fenceLine + 1, message: 'Code block is never closed; the rest of the file was skipped' })

  const finish = (node: Draft, parentKey: string, seen: Map<string, number>): RoadmapNode => {
    const base = slug(node.title)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const key = (parentKey ? parentKey + '/' : '') + (count > 1 ? `${base}#${count}` : base)
    const childSeen = new Map<string, number>()
    const children = node.children.map(c => finish(c as Draft, key, childSeen))

    let done = 0
    let total = 0
    for (const c of children) {
      done += c.done
      total += c.total
    }
    let status = node.status
    if (children.length && !node.explicit) status = deriveStatus(children)
    if (!children.length && !node.isHeading && status !== 'dropped') {
      total = 1
      done = status === 'done' ? 1 : 0
    }
    if (status === 'dropped') {
      done = 0
      total = 0
    }
    if (node.explicit && status === 'done' && children.some(c => c.status === 'todo' || c.status === 'doing' || c.status === 'blocked')) {
      warnings.push({ line: node.line + 1, message: `"${node.title}" is marked done but has open sub-items` })
    }

    const out: RoadmapNode = {
      key, title: node.title, status, explicit: node.explicit, isHeading: node.isHeading,
      line: node.line, children, done, total,
    }
    if (node.noteLines.length) out.note = node.noteLines.join(' ')
    return out
  }

  const seen = new Map<string, number>()
  const nodes = roots.map(n => finish(n, '', seen))
  warnings.sort((a, b) => a.line - b.line)
  return title === undefined ? { nodes, warnings } : { title, nodes, warnings }
}

export function deriveStatus(children: RoadmapNode[]): Status {
  const live = children.filter(c => c.status !== 'dropped')
  if (!live.length) return children.length ? 'dropped' : 'todo'
  if (live.every(c => c.status === 'done')) return 'done'
  if (live.some(c => c.status === 'doing')) return 'doing'
  if (live.some(c => c.status === 'done')) return 'doing'
  if (live.every(c => c.status === 'blocked')) return 'blocked'
  return 'todo'
}

export function* walk(nodes: RoadmapNode[], parents: RoadmapNode[] = []): Generator<[RoadmapNode, RoadmapNode[]]> {
  for (const n of nodes) {
    yield [n, parents]
    yield* walk(n.children, [...parents, n])
  }
}

export function findByKey(nodes: RoadmapNode[], key: string): RoadmapNode | undefined {
  for (const [n] of walk(nodes)) if (n.key === key) return n
  return undefined
}

/** Matches what the model or a person wrote ("User tab", "settings/user tab", a key) to one item. */
export function matchItem(nodes: RoadmapNode[], query: string): { node?: RoadmapNode; candidates: RoadmapNode[] } {
  const q = query.trim()
  const exactKey = findByKey(nodes, q)
  if (exactKey) return { node: exactKey, candidates: [exactKey] }

  const parts = q.split('/').map(p => slug(readMarkers(p).title)).filter(Boolean)
  const leaf = parts[parts.length - 1] ?? ''
  const all = [...walk(nodes)]
  const scored: [number, RoadmapNode][] = []
  for (const [n, parents] of all) {
    const s = slug(n.title)
    let score = 0
    if (s === leaf) score = 3
    else if (s.startsWith(leaf) || leaf.startsWith(s + '-')) score = 2
    else if (leaf.length >= 3 && s.includes(leaf)) score = 1
    if (!score) continue
    const path = parents.map(p => slug(p.title))
    const ok = parts.slice(0, -1).every(p => path.some(x => x === p || x.includes(p)))
    if (!ok) continue
    scored.push([score, n])
  }
  const best = Math.max(0, ...scored.map(([s]) => s))
  const candidates = scored.filter(([s]) => s === best).map(([, n]) => n)
  return candidates.length === 1 ? { node: candidates[0], candidates } : { candidates }
}

const STATUS_BOX: Record<Status, string> = { todo: ' ', doing: '~', done: 'x', blocked: '!', dropped: 'd' }

/**
 * Sets an item's checkbox in the file's text, touching only the marker. The item is found
 * again by key, then by unique title; returns an error when it can't be found unambiguously.
 */
export function setStatus(text: string, key: string, status: Status): { text: string } | { error: string } {
  const doc = parseRoadmap(text)
  let node = findByKey(doc.nodes, key)
  if (!node) {
    const title = key.split('/').pop() ?? key
    const same = [...walk(doc.nodes)].map(([n]) => n).filter(n => slug(n.title) === title.replace(/#\d+$/, ''))
    if (same.length !== 1) return { error: `Could not find "${key}" in the roadmap` }
    node = same[0]
  }
  if (!node) return { error: `Could not find "${key}" in the roadmap` }
  if (node.isHeading) return { error: `"${node.title}" is a heading; its status comes from its items` }

  const bom = text.startsWith('﻿') ? '﻿' : ''
  const lines = text.slice(bom.length).split('\n')
  const raw = lines[node.line]
  if (raw === undefined) return { error: 'The roadmap changed while it was being edited' }
  const cr = raw.endsWith('\r') ? '\r' : ''
  const body = cr ? raw.slice(0, -1) : raw

  const m = /^([ \t]*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+)?)(\[[^\]]{0,2}\])?/.exec(body)
  if (!m) return { error: 'Could not read that line of the roadmap' }
  const lead = m[1] ?? ''
  const box = `[${STATUS_BOX[status]}]`
  const next = m[2] ? lead + box + body.slice(lead.length + m[2].length) : lead + box + ' ' + body.slice(lead.length)
  lines[node.line] = next + cr
  return { text: bom + lines.join('\n') }
}

/** Overall progress over leaf items. */
export function progress(nodes: RoadmapNode[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const n of nodes) {
    done += n.done
    total += n.total
  }
  return { done, total }
}
