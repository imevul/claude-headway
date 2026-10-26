# Headway roadmap

## Build
- [x] P0: Plan and name
  - [x] Check for existing plugins
  - [x] Storage and live-status design
- [x] P1: Roadmap parser
  - [x] Forgiving Markdown parser (any depth, headings, emoji, tags)
  - [x] Derived status and progress counts
  - [x] Marker-only write-back
- [x] P2: Expand/collapse and window logic
  - [x] Defaults, overrides, auto-collapse on completion
  - [x] Folding long runs of done items
  - [x] Follow mode and auto-scroll
- [x] P3: The pane and live status
  - [x] Pane rendering on terminal and desktop
  - [x] Focus tool and task-list mirroring
  - [x] Tests (parser, expand, window, UI)
  - [x] Live check in the desktop app
- [~] P4: Load everywhere
  - [x] Add to CLAUDE_CODE_PLUGIN_DIRS
  - [ ] Try it in a real project with several sessions

## Later
- [ ] P5: Polish
  - [ ] Click an item to ask Claude about it
  - [x] Share as a GitHub repository
  - [x] Progress bar above the prompt
  - [x] Prettier desktop drawing
