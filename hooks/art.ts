// Pictures for the surfaces that draw SVG: the progress strip at the top of the pane.
import type { RoadmapNode, Status } from '../types'

import { walk } from './roadmap'

const FILL: Record<Exclude<Status, 'dropped'>, string> = {
  done: '#3fb950',
  doing: '#e3a21a',
  blocked: '#f85149',
  todo: 'rgba(140,140,140,0.30)',
}

/** The statuses of the leaf items, in file order, dropped ones left out. */
export function leafStatuses(nodes: RoadmapNode[]): Exclude<Status, 'dropped'>[] {
  const out: Exclude<Status, 'dropped'>[] = []
  for (const [n] of walk(nodes)) {
    if (n.isHeading || n.children.length || n.status === 'dropped') continue
    out.push(n.status)
  }
  return out
}

/**
 * One segment per item while they fit, so the strip also shows where in the roadmap the
 * work is; past that, one bar split by status.
 */
export function progressSvg(statuses: Exclude<Status, 'dropped'>[], width = 320, height = 8): string {
  const rects: string[] = []
  if (statuses.length && statuses.length <= 60) {
    const gap = statuses.length > 30 ? 1 : 2
    const w = (width - gap * (statuses.length - 1)) / statuses.length
    statuses.forEach((s, i) => {
      const x = i * (w + gap)
      rects.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}" rx="${Math.min(2, w / 2).toFixed(2)}" fill="${FILL[s]}"/>`)
    })
  } else {
    const order: Exclude<Status, 'dropped'>[] = ['done', 'doing', 'blocked', 'todo']
    let x = 0
    rects.push(`<rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" fill="${FILL.todo}"/>`)
    const parts: string[] = []
    for (const s of order.slice(0, 3)) {
      const w = statuses.length ? (statuses.filter(v => v === s).length / statuses.length) * width : 0
      if (w > 0) parts.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}" fill="${FILL[s]}"/>`)
      x += w
    }
    rects.push(`<clipPath id="c"><rect width="${width}" height="${height}" rx="${height / 2}"/></clipPath><g clip-path="url(#c)">${parts.join('')}</g>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rects.join('')}</svg>`
}
