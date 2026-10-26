import { atom, read, update } from 'claude-code'
import type { CommandRunInput, EngineInterface, Register } from 'claude-code'

import type { Model, Override, RoadmapNode, SessionInfo, Status, Warning, WindowState } from '../types'
import { leafStatuses, progressSvg } from './art'
import { currentKey, flatten, reconcile, type Row } from './expand'
import { matchItem, parseRoadmap, progress, setStatus } from './roadmap'
import { IDLE_MS, MAX_ROWS, placeWindow, scrollWindow, tickWindow } from './window'

type Engine = EngineInterface

const PANE = 'headway'
const TICK_MS = 2000
const DISCOVER_MS = 30_000
const STALE_MS = 10 * 60_000
const GONE_MS = 24 * 60 * 60_000
const INIT_WAIT_MS = 4000
const DEFAULT_PATHS = 'ROADMAP.md, docs/ROADMAP.md, docs/internal/ROADMAP.md'

const model = atom({ plugin: 'headway', key: 'model' } as const, null)
const overrides = atom({ plugin: 'headway', key: 'overrides' } as const, {})
const windowState = atom({ plugin: 'headway', key: 'window' } as const, { start: 0, follow: true, lastInteract: 0 })
const showWarnings = atom({ plugin: 'headway', key: 'showWarnings' } as const, false)

const GLYPH: Record<Status, [string, string | undefined]> = {
  done: ['✓', 'success'],
  doing: ['●', 'warning'],
  todo: ['○', undefined],
  blocked: ['!', 'error'],
  dropped: ['✕', undefined],
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/')
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const cut = (s: string, n: number) => (n <= 1 ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s)

/** The roadmap's path as the pane shows it: relative to the project, or the end of an absolute one. */
function shortPath(p: string): string {
  if (!p.startsWith('/')) return p
  if (root && p.startsWith(root + '/')) return p.slice(root.length + 1)
  const parts = p.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}

/** "2 lines not understood · 1 thing to check" */
function noticeLabel(warnings: Warning[]): string {
  const n = (k: string) => warnings.filter(w => w.kind === k).length
  const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`
  return [
    n('parse') ? plural(n('parse'), 'line not understood', 'lines not understood') : '',
    n('check') ? plural(n('check'), 'thing to check', 'things to check') : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function bar(done: number, total: number, width = 10): string {
  const filled = total ? Math.round((done / total) * width) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const INIT_PROMPT = (file: string) =>
  `Draft a roadmap for this project in \`${file}\`. Read the codebase, README and any docs/plans first. ` +
  `Use a Markdown checklist: \`# <Project> roadmap\`, optional \`##\`/\`###\` headings for slices or sprints, and nested items ` +
  `\`- [x]\` done, \`- [~]\` in progress, \`- [ ]\` todo, \`- [!]\` blocked. Number top-level phases (P0, P1, ...). ` +
  `Mark what already exists as done, keep items outcome-sized (not tiny steps), and nest sub-items where a phase has parts.`

const GUIDE = (file: string, checks: Warning[]) =>
  [
    `This project keeps its roadmap in \`${file}\` (a Markdown checklist, shown live in the Headway pane).`,
    'Markers: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked, `~~text~~` dropped; nesting by indentation and headings.',
    '- When you start work on a roadmap item, call the `mcp__headway__focus` tool with the item (its title is enough) so the pane shows what this session is on.',
    '- When an item is finished, call it again with `status: "done"` (or edit the marker yourself). Parents are derived from their children.',
    '- Add newly discovered roadmap-level work as items in the right place. Small steps belong in your task list, not the roadmap.',
    "- Keep the file's existing style; change only the lines you mean to.",
    ...(checks.length
      ? [
          '',
          `Things to check in \`${file}\` right now (the pane shows them too). Mention them to the user when they bear on the work; ` +
            "fix one only when it's clearly right (say, the open item is in fact done), and otherwise ask:",
          ...checks.slice(0, 10).map(c => `- line ${c.line}: ${c.message}`),
          ...(checks.length > 10 ? [`- and ${checks.length - 10} more`] : []),
        ]
      : []),
  ].join('\n')

// Module state: cheap caches a reload starts over, refilled by the next tick.
let searchPaths: string[] = []
let root = ''
let selfId = ''
let file: string | undefined
let others: string[] = []
let discoveredAt = 0
let fileMtime = -1
let roadmapText = ''
let roadmap: Model['roadmap']
let readError: string | undefined
let lastModelJson = ''
let bodyRows = 30
let self: SessionInfo = { sessionId: '', title: '', state: 'idle', updatedAt: 0 }
let planSteps: { content: string; status: string }[] = []
let ticking = false
let initPending = false
let lookups: string[] = []
let showBand = true

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120)

/** A roadmap path from config or discovery: relative to the project root, or absolute. */
function abs(p: string) {
  if (p.startsWith('/')) return p
  return p === '.' ? root : join(root, p)
}

function sessionsDir() {
  return join(root, '.headway', 'sessions')
}

async function discover($: Engine) {
  discoveredAt = Date.now()
  const found: string[] = []
  try {
    const cfg = JSON.parse(await $.fs.read(join(root, '.headway', 'config.json'))) as { roadmap?: unknown }
    if (typeof cfg.roadmap === 'string' && (await $.fs.exists(abs(cfg.roadmap)))) found.push(cfg.roadmap)
  } catch {
    // No project override.
  }
  const seen: string[] = []
  for (const p of searchPaths) {
    // The exact name first; then the folder's listing, for another spelling of the name.
    try {
      if (await $.fs.exists(abs(p))) {
        if (!found.includes(p)) found.push(p)
        seen.push(`${p}: found`)
        continue
      }
    } catch (err) {
      seen.push(`${p}: exists failed (${errText(err)})`)
    }
    try {
      const entries = await $.fs.list(abs(dirOf(p) || '.'))
      const hit = entries.find(en => en.kind !== 'dir' && en.name.toLowerCase() === baseOf(p).toLowerCase())
      if (hit) {
        const rel = join(dirOf(p), hit.name)
        if (!found.includes(rel)) found.push(rel)
      }
      seen.push(`${p}: ${hit ? `found as ${hit.name}` : `not among ${entries.length} entries`}`)
    } catch (err) {
      seen.push(`${p}: no folder (${errText(err)})`)
    }
  }
  lookups = seen
  if (found[0] !== file) fileMtime = -1
  file = found[0]
  others = found.slice(1)
  if (!file) {
    roadmap = undefined
    roadmapText = ''
  }
}

async function readSessions($: Engine, now: number): Promise<SessionInfo[]> {
  let entries: Awaited<ReturnType<Engine['fs']['list']>> = []
  try {
    entries = await $.fs.list(sessionsDir())
  } catch {
    return []
  }
  const out: SessionInfo[] = []
  for (const en of entries) {
    if (!en.name.endsWith('.json')) continue
    const path = join(sessionsDir(), en.name)
    try {
      const s = JSON.parse(await $.fs.read(path)) as SessionInfo
      if (s.sessionId === selfId) continue
      if (s.state === 'ended' || now - s.updatedAt > GONE_MS) {
        void $.process.run(['rm', '-f', path]).catch(() => undefined)
        continue
      }
      out.push(s)
    } catch {
      // Half-written or foreign file: skip it this tick.
    }
  }
  return out
}

async function writeSelf($: Engine, patch: Partial<SessionInfo>) {
  if (!root || !selfId) return
  self = { ...self, ...patch, sessionId: selfId, updatedAt: Date.now() }
  // Projects without a roadmap get no .headway folder.
  if (file) {
    try {
      if (!(await $.fs.exists(join(root, '.headway', '.gitignore')))) {
        await $.fs.write(join(root, '.headway', '.gitignore'), 'sessions/\n')
      }
      await $.fs.write(join(sessionsDir(), `${selfId}.json`), JSON.stringify(self, null, 2) + '\n')
    } catch {
      // Read-only checkout: the pane still shows this session from memory.
    }
  }
  await refresh($)
}

type Layout = {
  rows: Row[]
  current: number
  size: number
  start: number
}

function layout(m: Model, ov: Record<string, Override>, w: WindowState, footerRows: number): Layout {
  const nodes = m.roadmap?.nodes ?? []
  const cur = currentKey(nodes, m.sessions, m.selfId)
  const rows = flatten(nodes, { overrides: ov, sessions: m.sessions, selfId: m.selfId, current: cur })
  const current = rows.findIndex(r => r.kind === 'node' && r.key === cur)
  const header = 5
  const size = Math.max(3, Math.min(MAX_ROWS, bodyRows - header - footerRows - 2))
  return { rows, current, size, start: placeWindow(rows.length, current, size, w) }
}

function footerRowsOf(m: Model, w: WindowState, warn: boolean): number {
  const extra = footerSessions(m).length
  const sessions = extra ? 2 + extra : 0
  const warnings = m.roadmap?.warnings.length ? 1 + (warn ? Math.min(5, m.roadmap.warnings.length) : 0) : 0
  return sessions + warnings + (w.follow ? 0 : 1) + (m.readError ? 1 : 0)
}

/** Sessions the tree doesn't show: no claim, or a claim on an item that no longer exists. */
function footerSessions(m: Model): SessionInfo[] {
  const nodes = m.roadmap?.nodes ?? []
  const keys = new Set<string>()
  const visit = (ns: RoadmapNode[]) => ns.forEach(n => (keys.add(n.key), visit(n.children)))
  visit(nodes)
  return m.sessions.filter(s => s.state !== 'ended' && (!s.itemKey || !keys.has(s.itemKey))).slice(0, 3)
}

async function refresh($: Engine, opts: { force?: boolean } = {}) {
  // The session can change folder after it starts (the desktop app moving it into the project, /cd, a worktree).
  const current = await $.session.root().catch(() => '')
  if (current && current !== root) {
    root = current
    file = undefined
    roadmap = undefined
    roadmapText = ''
    fileMtime = -1
    discoveredAt = 0
  }
  if (!root) return
  const now = Date.now()
  if (opts.force || !file || now - discoveredAt > DISCOVER_MS) await discover($)

  if (file) {
    try {
      const st = await $.fs.stat(abs(file))
      if (opts.force || st.mtimeMs !== fileMtime) {
        roadmapText = await $.fs.read(abs(file))
        roadmap = parseRoadmap(roadmapText)
        fileMtime = st.mtimeMs
        readError = undefined
      }
    } catch (err) {
      readError = `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`
      fileMtime = -1
      discoveredAt = 0
    }
  }

  const sessions = await readSessions($, now)
  if (selfId) sessions.unshift(self.updatedAt ? self : { ...self, sessionId: selfId, updatedAt: now })
  const next: Model = {
    root,
    file,
    others,
    searchPaths,
    roadmap,
    readError,
    sessions: sessions.map(s =>
      s.state === 'working' && now - s.updatedAt > STALE_MS ? { ...s, state: 'idle' as const } : s,
    ),
    selfId,
    now: Math.floor(now / 60_000) * 60_000,
  }
  const json = JSON.stringify(next)
  if (json !== lastModelJson) {
    lastModelJson = json
    await update($, model, () => next)
  }

  if (roadmap) {
    const ov = await read($, overrides)
    const r = reconcile(ov, roadmap.nodes)
    if (r.changed) await setOverrides($, r.overrides)
  }

  const w = await read($, windowState)
  const ticked = tickWindow(w, now)
  const l = layout(next, await read($, overrides), ticked, footerRowsOf(next, ticked, await read($, showWarnings)))
  if (ticked !== w || l.start !== w.start) await update($, windowState, v => ({ ...tickWindow(v, now), start: l.start }))
}

async function setOverrides($: Engine, next: Record<string, Override>) {
  await update($, overrides, () => next)
  await $.store.set(`overrides:${root}`, next)
}

async function tick($: Engine) {
  if (ticking) return
  ticking = true
  try {
    await refresh($)
    if (self.updatedAt && Date.now() - self.updatedAt > STALE_MS / 2) await writeSelf($, {})
  } finally {
    ticking = false
  }
}


async function fillIfNoTurn($: Engine, text: string) {
  if (!initPending) return
  initPending = false
  const filled = await $.prompt.fill({ text }).catch(() => ({ isFilled: false }))
  $.ui.toast(
    filled.isFilled
      ? 'Headway: the roadmap prompt is in the prompt box. Press Enter to send it.'
      : 'Headway: could not start the roadmap prompt. Ask Claude to draft ROADMAP.md.',
  )
}

async function load($: Engine, surface: string | null) {
  try {
    // A reload (or a resumed session) picks up its own claim and step where it left them.
    const saved = JSON.parse(await $.fs.read(join(sessionsDir(), `${selfId}.json`))) as SessionInfo
    self = { ...self, ...saved, sessionId: selfId }
  } catch {
    // First start in this project.
  }

  const band = await $.store.get('showBand')
  if (typeof band === 'boolean') showBand = band

  const stored = (await $.store.get(`overrides:${root}`)) as Record<string, Override> | undefined
  if (stored && Object.keys(await read($, overrides)).length === 0) await update($, overrides, () => stored)

  await refresh($, { force: true })
  if (file && (surface === 'desktop' || surface === 'vscode')) void openPane($)
}

async function runCommand($: Engine, e: CommandRunInput) {
  const arg = e.args.trim().toLowerCase()
  await refresh($, { force: true })

  if (arg === 'where') {
    return {
      text: [
        file ? `Roadmap: ${abs(file)}` : 'No roadmap file found.',
        others.length ? `Also found (not used): ${others.join(', ')}` : '',
        `Project root: ${root}`,
        `Search order: .headway/config.json "roadmap", then ${searchPaths.join(', ')}`,
        ...lookups.map(l => `  ${l}`),
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  if (arg === 'band' || arg.startsWith('band ')) {
    const want = arg === 'band' ? !showBand : !/\b(off|hide|false|no)\b/.test(arg)
    showBand = want
    // The option is a settings row (what /config shows in a terminal); keep a store copy where no row is reachable.
    const row = (await $.config.list()).find(r => /^headway(@[^.]*)?\.showBand$/.test(r.key))
    const set = row ? await $.config.set({ key: row.key, value: want }) : { deny: 'no settings row' }
    if (set.deny) await $.store.set('showBand', want)
    else await $.store.delete('showBand')
    $.ui.invalidate('ui.render')
    const where = set.deny ? 'for now (it could not be saved to settings)' : 'and saved to your settings'
    return { text: `Progress bar above the prompt: ${want ? 'on' : 'off'}, ${where}.` }
  }

  if (arg === 'init') {
    const target = file ?? searchPaths[0] ?? 'ROADMAP.md'
    const text = file
      ? `Review and update the roadmap in \`${file}\` against the current state of the code: mark finished items done, add missing work, keep its style.`
      : INIT_PROMPT(target)
    initPending = true
    void $.prompt.submit({ text }).catch(() => undefined)
    // Where the host doesn't start a turn for a plugin's prompt, hand the prompt to the person instead.
    $.clock.after(INIT_WAIT_MS, () => fillIfNoTurn($, text))
    void openPane($)
    return { text: file ? `Asked Claude to refresh ${file}.` : `Asked Claude to draft ${target}.` }
  }

  await openPane($)
  return { text: file ? `Headway: showing ${file}.` : `Headway: no roadmap yet (looked in ${searchPaths.join(', ')}).` }
}

function openPane($: Engine) {
  return $.ui.open({ id: PANE, title: 'Headway' })
}

export const register: Register = (on, options) => {
  showBand = (options as { showBand?: unknown }).showBand !== false
  searchPaths = String((options as { searchPaths?: unknown }).searchPaths ?? DEFAULT_PATHS)
    .split(',')
    .map(s => s.trim().replace(/^\.?\//, ''))
    .filter(Boolean)


  on('session.start', async ($, e, next) => {
    // Commands and the tool first: the session takes input as soon as this hook returns.
    await $.command.register({
      name: 'headway',
      description: 'Show the project roadmap pane (init: draft a roadmap, where: which file is used, band on|off: progress bar above the prompt)',
      argumentHint: '[init | where | band on|off]',
    })
    await $.tool.register({
      name: 'focus',
      isDeferred: false,
      description:
        "Tell the Headway roadmap pane which roadmap item this session is working on, and update that item's status in the roadmap file. " +
        'Call it when you start on a roadmap item (status "doing", the default) and when you finish it (status "done"). ' +
        '`item` is the item\'s title, or a path of titles like "Settings page/User tab".',
      inputSchema: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The roadmap item: its title, or parent titles and title joined by "/"' },
          step: { type: 'string', description: 'Optional: what you are doing on it right now, a few words' },
          status: { type: 'string', enum: ['doing', 'done', 'blocked', 'todo'], description: 'Default "doing"' },
        },
        required: ['item'],
      },
    })

    const started = await next(e)
    // The session's own project root: a worktree's, not the main checkout's.
    root = (await $.session.root().catch(() => '')) || e.cwd
    selfId = await $.session.id()
    self = { sessionId: selfId, title: `Session ${selfId.slice(0, 6)}`, state: 'idle', updatedAt: 0 }
    $.clock.every(TICK_MS, () => tick($))
    // The rest reads files; it runs beside the session's start rather than holding it up.
    $.clock.after(0, () => load($, e.surface))
    return started
  })

  on('session.end', async ($, e, next) => {
    if (root && selfId) {
      await $.process.run(['rm', '-f', join(sessionsDir(), `${selfId}.json`)]).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    initPending = false
    // Title the session after its first real prompt; tagged system text (notifications, reminders) doesn't count.
    const words = e.text.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    const untitled = self.title.startsWith('Session ') || self.title.startsWith('<')
    await writeSelf($, { state: 'working', title: untitled && words ? cut(words, 48) : untitled ? `Session ${selfId.slice(0, 6)}` : self.title })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await writeSelf($, { state: 'idle' })
    return done
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!file) return composed
    const checks = roadmap?.warnings.filter(w => w.kind === 'check') ?? []
    return { sections: [...composed.sections, { id: 'headway', text: GUIDE(file, checks), scope: 'session' as const }] }
  })

  // Mirror the session's task list into its live status: the desktop app's update_plan, the CLI's TodoWrite.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    let step: string | undefined

    if (tool === 'mcp__ccd_turn__update_plan') {
      const items = input.items as { content: string; status: string }[] | undefined
      if (Array.isArray(items)) planSteps = items.map(i => ({ content: String(i.content), status: String(i.status) }))
      const at = planSteps.findIndex(i => i.status === 'in_progress')
      if (input.advance === true && at >= 0) {
        planSteps[at]!.status = 'completed'
        const nx = planSteps.findIndex((i, n) => n > at && i.status === 'pending')
        if (nx >= 0) planSteps[nx]!.status = 'in_progress'
      }
      for (const n of (input.done as number[] | undefined) ?? []) if (planSteps[n - 1]) planSteps[n - 1]!.status = 'completed'
      const start = input.start as number | undefined
      if (start && planSteps[start - 1]) planSteps[start - 1]!.status = 'in_progress'
      step = planSteps.find(i => i.status === 'in_progress')?.content ?? ''
    } else if (tool === 'TodoWrite') {
      const todos = input.todos as { content: string; status: string; activeForm?: string }[] | undefined
      const active = todos?.find(t => t.status === 'in_progress')
      step = active?.activeForm ?? active?.content ?? ''
    } else if (tool === 'TaskUpdate' || tool === 'TaskCreate') {
      if (input.status === 'in_progress' || tool === 'TaskCreate') {
        const s = (input.activeForm ?? input.subject) as string | undefined
        if (s && input.status === 'in_progress') step = s
      } else if (input.status === 'completed') {
        step = ''
      }
    }

    if (step !== undefined && step !== (self.step ?? '')) await writeSelf($, { step: step || undefined })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__headway__focus' }, async ($, e) => {
    const input = e as unknown as { item?: unknown; step?: unknown; status?: unknown }
    const query = String(input.item ?? '').trim()
    const status = (['doing', 'done', 'blocked', 'todo'].includes(String(input.status)) ? input.status : 'doing') as Status
    await refresh($, { force: true })
    if (!file || !roadmap) {
      return { result: `No roadmap file found (looked in ${searchPaths.join(', ')}). Run /headway init to draft one.` }
    }

    const { node, candidates } = matchItem(roadmap.nodes, query)
    if (!node) {
      const list = candidates.slice(0, 8).map(c => `- ${c.key}`).join('\n')
      return {
        result: candidates.length
          ? `"${query}" matches several items; call again with one of these keys:\n${list}`
          : `No roadmap item matches "${query}". Add it to ${file} first if it is new work.`,
      }
    }

    let note = ''
    const wanted = node.isHeading ? node.status : status
    if (!node.isHeading && node.status !== wanted) {
      const edited = setStatus(roadmapText, node.key, wanted)
      if ('error' in edited) note = ` (left the file unchanged: ${edited.error})`
      else {
        await $.fs.write(abs(file), edited.text)
        note = ` and marked it ${wanted} in ${file}`
      }
    }

    const claim = status === 'done' || status === 'todo' ? { itemKey: undefined, step: undefined } : { itemKey: node.key }
    await writeSelf($, { ...claim, ...(typeof input.step === 'string' && input.step ? { step: input.step } : {}) })
    await refresh($, { force: true })
    const verb = status === 'done' ? 'Finished' : status === 'todo' ? 'Released' : 'Now on'
    return { result: `${verb} "${node.title}" (${node.key})${note}.` }
  }).catch(() => ({ result: 'Headway could not update the roadmap this time; carry on without it.' }))

  // Also answers a personal `headway.md` command file (extras/headway.md), which the desktop app knows before
  // the session has started, so that file's text never reaches the model.
  on('command.run', { command: 'headway' }, runCommand)

  // The pane owns its scrolling so the header stays put: move our window, not the engine's.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const m = await read($, model)
    if (!m) return {}
    const w = await read($, windowState)
    const l = layout(m, await read($, overrides), w, footerRowsOf(m, w, await read($, showWarnings)))
    const by = Math.sign(e.by) * Math.max(1, Math.abs(e.by))
    await update($, windowState, v => scrollWindow(l.rows.length, l.current, l.size, v, by, Date.now()))
    return {}
  }).catch(() => ({}))

  // A slim progress strip above the prompt; the pane holds the detail.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, model)
    if (!showBand || e.props.hasSurvey || !m?.roadmap) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const p = progress(m.roadmap.nodes)
    if (!p.total) return next(e)
    const pct = Math.round((p.done / p.total) * 100)
    const label = `${pct}% · ${p.done}/${p.total}`

    if (e.surface === 'terminal') {
      const width = Math.max(6, Math.min(40, e.props.bodyColumns - label.length - 2))
      return (
        <Box flexDirection="row" gap={1}>
          <Text color="success">{bar(p.done, p.total, width)}</Text>
          <Text dimColor tabular>{label}</Text>
        </Box>
      )
    }
    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexGrow={1}>
          <Svg source={progressSvg(leafStatuses(m.roadmap.nodes), 600, 6)} alt={`Roadmap ${pct}% done`} height={6} />
        </Box>
        <Text dimColor size="caption" tabular>{label}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, model)
    const ov = await read($, overrides)
    const w = await read($, windowState)
    const warn = await read($, showWarnings)
    const cols = Math.max(20, e.props.bodyColumns)
    bodyRows = e.props.scroll.bodyRows || bodyRows

    if (!m) return <Text dimColor>Loading roadmap…</Text>

    if (!m.file || !m.roadmap) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold" size="heading">No roadmap yet</Text>
          <Text dimColor>Looked for {m.searchPaths.join(', ')} (and .headway/config.json).</Text>
          <Box>
            <Button key="init" variant="primary" onPress={() => void $.command.run({ command: 'headway', args: 'init' })}>
              Draft a roadmap
            </Button>
          </Box>
        </Box>
      )
    }

    const nodes = m.roadmap.nodes
    const p = progress(nodes)
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
    const l = layout(m, ov, w, footerRowsOf(m, w, warn))
    const shown = l.rows.slice(l.start, l.start + l.size)
    const above = l.start
    const below = Math.max(0, l.rows.length - l.start - l.size)
    const now = Date.now()

    const persist = (v: Record<string, Override>) => $.store.set(`overrides:${root}`, v)
    const toggle = (r: Extract<Row, { kind: 'node' | 'fold' }>) => {
      if (r.kind === 'node') return () => update($, overrides, o => ({ ...o, [r.key]: { open: !r.open, status: r.node.status } })).then(persist)
      return () =>
        update($, overrides, o => {
          const { [r.key]: _, ...rest } = o
          return r.open ? rest : { ...o, [r.key]: { open: true, status: 'done' as const } }
        }).then(persist)
    }
    const scrollBy = (by: number) => () =>
      update($, windowState, v => scrollWindow(l.rows.length, l.current, l.size, v, by, Date.now()))

    // Indentation is a Box's padding: surfaces that lay out in pixels collapse leading spaces.
    const line = (key: string, depth: number, ...children: unknown[]) => (
      <Box key={key} flexDirection="row" paddingLeft={depth * 2} gap={1}>
        {children as never}
      </Box>
    )

    const sessionRow = (key: string, s: SessionInfo, isSelf: boolean, depth: number) => {
      const stale = now - s.updatedAt > STALE_MS
      const working = s.state === 'working' && !stale
      const name = `${s.title}${isSelf ? ' (this session)' : ''}`
      const room = cols - depth * 2 - 4
      return line(
        key,
        depth,
        <Text color={working ? 'claude' : undefined} dimColor={!working}>{working ? '●' : '○'}</Text>,
        <Text color={working ? 'claude' : undefined} dimColor={!working} wrap="truncate-end">
          {cut(name, room)}
          <Text dimColor>{s.step ? ` — ${cut(s.step, Math.max(0, room - name.length - 3))}` : ''}{stale ? ' (stale)' : ''}</Text>
        </Text>,
      )
    }

    const rowEl = (r: Row) => {
      if (r.kind === 'session') return sessionRow(r.key, r.session, r.isSelf, r.depth)
      if (r.kind === 'note') {
        return line(r.key, r.depth + 1, <Text dimColor italic wrap="truncate-end">{cut(r.text, cols - r.depth * 2 - 2)}</Text>)
      }
      if (r.kind === 'fold') {
        const range = `${r.nodes[0]!.title} – ${r.nodes[r.nodes.length - 1]!.title}`
        return line(
          r.key,
          r.depth,
          <Text color="success">✓</Text>,
          <Button key={r.key} plain dimColor onPress={toggle(r)}>
            {`${r.open ? '▾' : '▸'} ${r.nodes.length} completed`}
          </Button>,
          <Text dimColor size="caption" wrap="truncate-end">{cut(range, cols - r.depth * 2 - 20)}</Text>,
        )
      }

      const n = r.node
      const [glyph, color] = n.info ? ['·', undefined] : GLYPH[n.status]
      const count = n.children.length && n.total ? `${n.done}/${n.total}` : ''
      const quiet = n.info || ((n.status === 'done' || n.status === 'dropped' || n.status === 'todo') && !r.isCurrent && !n.isHeading)
      const room = cols - r.depth * 2 - 4 - (count ? count.length + 1 : 0) - (r.isCurrent ? 6 : 0)
      const title = cut(n.title, room)
      return line(
        r.key,
        r.depth,
        <Text color={color} dimColor={!color}>{glyph}</Text>,
        r.canOpen ? (
          <Button key={r.key} plain dimColor={quiet} onPress={toggle(r)}>
            {`${r.open ? '▾' : '▸'} ${title}`}
          </Button>
        ) : (
          <Text
            weight={r.isCurrent ? 'semibold' : undefined}
            color={r.isCurrent ? 'claude' : undefined}
            dimColor={quiet}
            strikethrough={n.status === 'dropped'}
            wrap="truncate-end"
          >
            {title}
          </Text>
        ),
        count ? <Text dimColor size="caption" tabular>{count}</Text> : null,
        r.isCurrent ? <Text color="claude" size="caption" weight="semibold">◂ now</Text> : null,
      )
    }

    const extra = footerSessions(m)
    const unread = m.roadmap.warnings.some(wn => wn.kind === 'parse')
    const working = m.sessions.filter(s => s.state === 'working' && now - s.updatedAt <= STALE_MS).length
    const title = m.roadmap.title ?? baseOf(m.root)
    const path = shortPath(m.file)
    const short = `${pct}% · ${p.done}/${p.total}`
    const more = m.sessions.length > 1 ? `${working} of ${m.sessions.length} sessions working` : ''

    let picture: unknown = null
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      picture = <Svg source={progressSvg(leafStatuses(nodes), 600, 8)} alt={`${pct}% done`} height={8} />
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text weight="semibold" size="heading" wrap="truncate-end">{cut(title, cols)}</Text>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {picture ? (
              <Box flexGrow={1}>{picture as never}</Box>
            ) : (
              <Text color="success">{bar(p.done, p.total, Math.max(6, Math.min(24, cols - short.length - 2)))}</Text>
            )}
            <Text dimColor size="caption" tabular>
              {short}
            </Text>
          </Box>
          {more ? (
            <Text dimColor size="caption" wrap="truncate-end">
              {cut(more, cols)}
            </Text>
          ) : null}
          <Text dimColor size="caption" wrap="truncate-end">
            {cut(path + (m.others.length ? `  (also: ${m.others.join(', ')})` : ''), cols)}
          </Text>
        </Box>
        {l.rows.length > l.size ? (
          <Button key="up" plain dimColor onPress={scrollBy(-l.size)}>
            {above ? `↑ ${above} more` : ' '}
          </Button>
        ) : null}
        {shown.map(rowEl)}
        {l.rows.length > l.size ? (
          <Button key="down" plain dimColor onPress={scrollBy(l.size)}>
            {below ? `↓ ${below} more` : ' '}
          </Button>
        ) : null}
        {w.follow ? null : (
          <Box marginTop={1}>
            <Button key="jump" plain onPress={() => update($, windowState, v => ({ ...v, follow: true, lastInteract: Date.now() - IDLE_MS }))}>
              ⌖ Jump to current
            </Button>
          </Box>
        )}
        {extra.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor size="caption">Not on a roadmap item</Text>
            {extra.map(s => sessionRow(`extra:${s.sessionId}`, s, s.sessionId === m.selfId, 0))}
          </Box>
        ) : null}
        {m.readError ? <Text color="error">{cut(m.readError, cols)}</Text> : null}
        {m.roadmap.warnings.length ? (
          <Box flexDirection="row" gap={1} marginTop={1}>
            {unread ? <Text color="warning">⚠</Text> : <Text dimColor>ⓘ</Text>}
            <Button key="warnings" plain dimColor onPress={() => update($, showWarnings, v => !v)}>
              {`${warn ? '▾' : '▸'} ${noticeLabel(m.roadmap.warnings)}`}
            </Button>
          </Box>
        ) : null}
        {warn
          ? m.roadmap.warnings.slice(0, 5).map(wn => (
              <Text dimColor size="caption" wrap="truncate-end">{cut(`  line ${wn.line}: ${wn.message}`, cols)}</Text>
            ))
          : null}
      </Box>
    )
  })
}
