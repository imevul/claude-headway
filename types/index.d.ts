export type Status = 'todo' | 'doing' | 'done' | 'blocked' | 'dropped'

export type RoadmapNode = {
  key: string
  title: string
  status: Status
  /** Whether the status was written on the line, rather than derived from children. */
  explicit: boolean
  isHeading: boolean
  /** A section with no status markers in a roadmap that otherwise has them (known limitations, notes): not counted. */
  info?: boolean
  /** 0-based line in the file. */
  line: number
  note?: string
  children: RoadmapNode[]
  /** Leaf items done / counted (dropped leaves are not counted). */
  done: number
  total: number
}

/** `parse`: a line that could not be read as meant. `check`: read fine, but inconsistent (a done parent with open items). */
export type Warning = { line: number; message: string; kind: 'parse' | 'check' }

export type Roadmap = {
  title?: string
  nodes: RoadmapNode[]
  warnings: Warning[]
}

export type SessionInfo = {
  sessionId: string
  title: string
  itemKey?: string
  step?: string
  state: 'working' | 'idle' | 'ended'
  updatedAt: number
}

export type Override = { open: boolean; status: Status }

export type Model = {
  root: string
  /** The roadmap file in use, relative to root; absent when none was found. */
  file?: string
  others: string[]
  searchPaths: string[]
  roadmap?: Roadmap
  readError?: string
  sessions: SessionInfo[]
  selfId: string
  now: number
}

export type WindowState = { start: number; follow: boolean; lastInteract: number }

declare module 'claude-code' {
  interface PluginState {
    headway: {
      model: Model | null
      overrides: Record<string, Override>
      window: WindowState
      showWarnings: boolean
    }
  }
}
