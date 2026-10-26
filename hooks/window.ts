// The scrolling window over the pane's rows: follows the current item until the person scrolls away.
import type { WindowState } from '../types'

export const MAX_ROWS = 18
export const IDLE_MS = 60_000

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Whether `index` sits inside the window with a little room either side, where there is room. */
function inView(index: number, start: number, size: number): boolean {
  const margin = Math.min(2, Math.floor(size / 4))
  const lo = start === 0 ? 0 : start + margin
  const hi = start + size - 1 - margin
  return index >= lo && index <= hi
}

/** The first row to draw. Following, the window moves only when the current item would leave it. */
export function placeWindow(total: number, current: number, size: number, w: WindowState): number {
  const maxStart = Math.max(0, total - size)
  if (total <= size) return 0
  const start = clamp(w.start, 0, maxStart)
  if (!w.follow || current < 0) return start
  const end = start + size - 1
  if (inView(current, start, size) || (start === maxStart && current >= start && current <= end)) return start
  return clamp(current - Math.floor(size / 3), 0, maxStart)
}

/** A scroll by the person: follow stays on only while the current item is still in view. */
export function scrollWindow(total: number, current: number, size: number, w: WindowState, by: number, now: number): WindowState {
  const from = placeWindow(total, current, size, w)
  const start = clamp(from + by, 0, Math.max(0, total - size))
  const follow = current >= 0 && current >= start && current < start + size
  return { start, follow, lastInteract: now }
}

/** Follow resumes after a minute without scrolling. */
export function tickWindow(w: WindowState, now: number): WindowState {
  return !w.follow && now - w.lastInteract >= IDLE_MS ? { ...w, follow: true } : w
}
