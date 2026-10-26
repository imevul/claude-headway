import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROADMAP = [
  '# Demo roadmap',
  '- [x] P0: Skeleton',
  '- [~] P2: Settings',
  '  - [x] General tab',
  '  - [~] User tab',
  '  - [ ] Import',
  '- [ ] P3: Auth',
  '  - [ ] login',
].join('\n')

const PANE = {
  plugin: 'headway',
  component: 'Pane',
  requestId: 'headway',
  props: {
    title: 'Headway',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** A tiny in-memory filesystem standing in for the engine's. */
function fakeFs(on: On, files: Record<string, string>) {
  let version = 1
  const dirs = () => new Set(Object.keys(files).flatMap(p => p.split('/').slice(1, -1).map((_, i, a) => '/' + a.slice(0, i + 1).join('/'))))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    version++
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files[e.path] !== undefined || dirs().has(e.path) }))
  on('fs.stat', (_, e) => {
    if (files[e.path] === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: files[e.path]!.length, mtimeMs: version, isLink: false } }
  })
  on('fs.list', (_, e) => {
    const dir = e.path.replace(/\/$/, '')
    if (!dirs().has(dir) && dir !== '') throw new Error(`ENOENT ${dir}`)
    const names = new Set<string>()
    for (const p of Object.keys(files)) if (p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')) names.add(p.slice(dir.length + 1))
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: version, isLink: false })) }
  })
  return { touch: () => version++ }
}

function engine(on: On, files: Record<string, string>) {
  mock.store(on)
  mock.clock(on)
  on('session.repo', () => ({ value: { root: '/proj', name: 'proj', remote: null, internal: false } }))
  on('session.id', () => ({ value: 'me-1234567' }))
  on('command.register', () => ({ value: { command: 'headway' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__headway__focus' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return fakeFs(on, files)
}

test('the pane opens the branch in progress and toggles rows, on terminal and desktop', async ($, on) => {
  const files: Record<string, string> = { '/proj/docs/internal/Roadmap.md': ROADMAP }
  engine(on, files)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Demo roadmap/ }))?.text).toBe('Demo roadmap')
    expect(await ui.find({ type: 'Text', text: /docs\/internal\/Roadmap\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^User tab$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^login$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /now/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()

    await ui.press({ key: 'p3-auth' })
    expect(await ui.find({ type: 'Text', text: /^login$/ })).toBeDefined()
    await ui.press({ key: 'p3-auth' })
    expect(await ui.find({ type: 'Text', text: /^login$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('focus marks the item in the file and another session shows under its item', async ($, on) => {
  const files: Record<string, string> = { '/proj/ROADMAP.md': ROADMAP }
  engine(on, files)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const r = await $.tool.call({ tool: 'mcp__headway__focus', item: 'Import', step: 'parsing CSV' })
  expect(String((r as { result?: unknown }).result)).toMatch(/Now on "Import"/)
  expect(files['/proj/ROADMAP.md']).toContain('  - [~] Import')
  expect(files['/proj/ROADMAP.md']).toContain('  - [~] User tab')

  files['/proj/.headway/sessions/other.json'] = JSON.stringify({
    sessionId: 'other', title: 'Auth work', itemKey: 'p3-auth/login', step: 'login form', state: 'working', updatedAt: Date.now(),
  })
  await $.command.run({ command: 'headway', args: 'where' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^login$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Auth work — login form/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /this session\) — parsing CSV/ })).toBeDefined()
  await ui.unmount()
})

test('with no roadmap the pane says where it looked', async ($, on) => {
  engine(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Looked for/ }))?.text).toMatch(/ROADMAP\.md, docs\/ROADMAP\.md, docs\/internal\/ROADMAP\.md/)
  expect(await ui.find({ key: 'init' })).toBeDefined()
  await ui.unmount()
})

test('the band above the prompt shows the progress bar', async ($, on) => {
  engine(on, { '/proj/ROADMAP.md': ROADMAP })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'headway',
      surface,
      component: 'AbovePrompt',
      requestId: 'band',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    } as never)
    expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toBe('40% · 2/5')
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }
})

test('/headway band off hides the progress bar', async ($, on) => {
  engine(on, { '/proj/ROADMAP.md': ROADMAP })
  on('config.list', () => ({ value: [] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'headway', args: 'band off' } as never)
  expect(String((out as { text?: unknown }).text)).toMatch(/off/)

  const ui = await $.ui.mount({
    plugin: 'headway',
    surface: 'desktop',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as never)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
})
