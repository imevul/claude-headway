import { describe, expect, test } from 'claude-code/testing'

import type { RoadmapNode } from '../types'
import { matchItem, parseRoadmap, progress, setStatus, walk } from './roadmap'

const titles = (ns: RoadmapNode[]) => ns.map(n => n.title)
const byTitle = (ns: RoadmapNode[], t: string) => [...walk(ns)].map(([n]) => n).find(n => n.title === t)

describe('parseRoadmap', () => {
  test('the example from the request: bullets with trailing emoji', () => {
    const doc = parseRoadmap(
      [
        '* P0: App spec and skeleton ✅',
        '* P1: Initial functionality ✅',
        '* P2: Settings page 🔁',
        '   * User interface & design ✔️',
        '   * General tab ✔️',
        '   * User tab ⬅️',
        '   * Import / export tab',
        '* P3: Authentication',
      ].join('\n'),
    )
    expect(titles(doc.nodes)).toEqual(['P0: App spec and skeleton', 'P1: Initial functionality', 'P2: Settings page', 'P3: Authentication'])
    expect(doc.nodes.map(n => n.status)).toEqual(['done', 'done', 'doing', 'todo'])
    expect(doc.nodes[2]!.children.map(n => n.status)).toEqual(['done', 'done', 'doing', 'todo'])
    expect(doc.warnings).toEqual([])
  })

  test('every checkbox form', () => {
    const doc = parseRoadmap('- [ ] a\n- [] b\n- [x] c\n- [X] d\n- [~] e\n- [/] f\n- [>] g\n- [!] h\n- [d] i\n- ~~j~~\n- [?] k')
    expect(doc.nodes.map(n => n.status)).toEqual(['todo', 'todo', 'done', 'done', 'doing', 'doing', 'doing', 'blocked', 'dropped', 'dropped', 'todo'])
    expect(doc.warnings.length).toBe(1)
    expect(doc.warnings[0]!.line).toBe(11)
  })

  test('headings nest four levels deep and items nest under them', () => {
    const doc = parseRoadmap(
      ['# Big roadmap', '## Slice A', '### Sprint 1', '#### Week 1', '- [x] one', '- [ ] two', '### Sprint 2', '- [~] three', '## Slice B', '- [ ] four'].join('\n'),
    )
    expect(doc.title).toBe('Big roadmap')
    expect(titles(doc.nodes)).toEqual(['Slice A', 'Slice B'])
    const a = doc.nodes[0]!
    expect(titles(a.children)).toEqual(['Sprint 1', 'Sprint 2'])
    expect(titles(a.children[0]!.children[0]!.children)).toEqual(['one', 'two'])
    expect(a.status).toBe('doing')
    expect(a.children[0]!.status).toBe('doing')
    expect(doc.nodes[1]!.status).toBe('todo')
  })

  test('mixed bullets, tabs and uneven indents', () => {
    const doc = parseRoadmap(['- [ ] top', '\t* [x] tab child', '     + [ ] five spaces', '  1. [x] numbered', '- [ ] next top'].join('\n'))
    expect(titles(doc.nodes)).toEqual(['top', 'next top'])
    const top = doc.nodes[0]!
    expect(titles(top.children)).toEqual(['tab child', 'numbered'])
    expect(titles(top.children[0]!.children)).toEqual(['five spaces'])
  })

  test('a jump of several indent levels is a child of the line above', () => {
    const doc = parseRoadmap('- a\n          - b\n  - c')
    expect(titles(doc.nodes[0]!.children)).toEqual(['b', 'c'])
  })

  test('skips front matter, code fences, comments, tables and quotes', () => {
    const doc = parseRoadmap(
      ['---', 'title: x', '- [ ] not an item', '---', '- [ ] real', '```', '- [ ] in code', '```', '<!-- - [ ] hidden', 'still hidden -->', '| - [ ] | table |', '> - [ ] quoted', '- [x] also real'].join('\n'),
    )
    expect(titles(doc.nodes)).toEqual(['real', 'also real'])
  })

  test('an unclosed code block is a warning, not a crash', () => {
    const doc = parseRoadmap('- [ ] a\n```\n- [ ] b')
    expect(titles(doc.nodes)).toEqual(['a'])
    expect(doc.warnings[0]!.message).toMatch(/never closed/)
  })

  test('derives parent status and counts leaves, skipping dropped ones', () => {
    const doc = parseRoadmap('- P1\n  - [x] a\n  - [x] b\n  - ~~c~~\n- P2\n  - [x] d\n  - [ ] e')
    expect(doc.nodes[0]!.status).toBe('done')
    expect([doc.nodes[0]!.done, doc.nodes[0]!.total]).toEqual([2, 2])
    expect(doc.nodes[1]!.status).toBe('doing')
    expect(progress(doc.nodes)).toEqual({ done: 3, total: 4 })
  })

  test('flags a parent marked done with open children', () => {
    const doc = parseRoadmap('- [x] P1\n  - [ ] not yet')
    expect(doc.nodes[0]!.status).toBe('done')
    expect(doc.warnings[0]!.message).toMatch(/open sub-items/)
  })

  test('notes, tags, links and bold', () => {
    const doc = parseRoadmap('- [ ] **Auth** via [OAuth](https://x)\n  Uses the provider SDK.\n- DONE: shipped thing\n- WIP: half thing\n- thing (blocked)')
    expect(doc.nodes[0]!.title).toBe('Auth via OAuth')
    expect(doc.nodes[0]!.note).toBe('Uses the provider SDK.')
    expect(doc.nodes.slice(1).map(n => [n.title, n.status])).toEqual([
      ['shipped thing', 'done'],
      ['half thing', 'doing'],
      ['thing', 'blocked'],
    ])
  })

  test('CRLF, BOM, and duplicate titles get distinct keys', () => {
    const doc = parseRoadmap('﻿# R\r\n- [ ] Tests\r\n- [x] Tests\r\n')
    expect(doc.title).toBe('R')
    expect(doc.nodes.map(n => n.key)).toEqual(['tests', 'tests#2'])
  })

  test('words that only look like tags stay part of the title', () => {
    const doc = parseRoadmap('- Complete checkout flow\n- Done button styling\n- Current user menu')
    expect(doc.nodes.map(n => [n.title, n.status])).toEqual([
      ['Complete checkout flow', 'todo'],
      ['Done button styling', 'todo'],
      ['Current user menu', 'todo'],
    ])
  })

  test('garbage never throws', () => {
    for (const junk of ['', '\n\n', '-', '- ', '[', '#', '####### seven', '- [x', '~~~', '<!--', '* * *', '1.']) {
      expect(() => parseRoadmap(junk)).not.toThrow()
    }
  })
})

describe('setStatus', () => {
  test('touches only the marker, keeping CRLF and the rest of the file', () => {
    const text = '# R\r\n- [ ] a\r\n  - [ ] b ✅\r\n- c\r\n'
    const doc = parseRoadmap(text)
    const b = byTitle(doc.nodes, 'b')!
    const r1 = setStatus(text, b.key, 'doing')
    expect('text' in r1 && r1.text).toBe('# R\r\n- [ ] a\r\n  - [~] b ✅\r\n- c\r\n')
    const r2 = setStatus(text, 'c', 'done')
    expect('text' in r2 && r2.text).toBe('# R\r\n- [ ] a\r\n  - [ ] b ✅\r\n- [x] c\r\n')
  })

  test('refuses headings and unknown items', () => {
    const text = '## Slice\n- [ ] a'
    expect(setStatus(text, 'slice', 'done')).toEqual({ error: expect.anything() })
    expect(setStatus(text, 'nope', 'done')).toEqual({ error: expect.anything() })
  })
})

describe('matchItem', () => {
  const doc = parseRoadmap('- P2: Settings page\n  - User tab\n  - General tab\n- P3: Users\n  - User tab')

  test('by path, by unique title, and ambiguity', () => {
    expect(matchItem(doc.nodes, 'Settings page/User tab').node?.key).toBe('p2-settings-page/user-tab')
    expect(matchItem(doc.nodes, 'general tab').node?.key).toBe('p2-settings-page/general-tab')
    expect(matchItem(doc.nodes, 'User tab').node).toBeUndefined()
    expect(matchItem(doc.nodes, 'User tab').candidates.length).toBe(2)
    expect(matchItem(doc.nodes, 'p3-users/user-tab').node?.title).toBe('User tab')
  })
})
