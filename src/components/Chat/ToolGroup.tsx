import React from 'react'
import { Box, Text } from '../../ui.js'
import type { ChatRow, ToolGroupKind, ToolGroupRow, ToolRow } from '../../adapter/ports/channel-view.js'
import { t, type I18nKey } from '../../i18n.js'

/** Tool ids that read or run without changing files, for backends whose
 *  views do not say (a generic card): these may join a folded run. */
const GROUPABLE_TOOL_NAMES = new Set([
  'bash', 'powershell', 'sh', 'shell', 'terminal',
  'read', 'read_image', 'glob', 'grep', 'ls', 'list',
  'web_search', 'websearch', 'web_fetch', 'webfetch',
])

/**
 * Whether a tool call may fold into a run (settings `dsh-tui.compactTools`):
 * read / search / terminal calls that did not fail. An error, a non-zero exit
 * or a signal keeps its own card, and so does anything that edits files or
 * asks the user (diff, todo, question, subagent cards).
 */
export function toolGroupable(tool: ToolRow | undefined): boolean {
  if (tool === undefined || tool.status === 'error') return false
  const view = tool.resultView ?? tool.callView
  if (view?.card === 'terminal') {
    return 'exitCode' in view ? (view.exitCode ?? 0) === 0 && view.signal === undefined : true
  }
  if (view?.card === 'read' || view?.card === 'search') return true
  if (view !== undefined && view.card !== 'generic') return false
  return GROUPABLE_TOOL_NAMES.has(tool.name.toLowerCase())
}

const SHELL_NAMES = new Set(['bash', 'powershell', 'sh', 'shell', 'terminal'])

/** What a groupable call did, for the summary sentence. */
export function toolKind(tool: ToolRow): ToolGroupKind {
  const name = tool.name.toLowerCase()
  const card = (tool.resultView ?? tool.callView)?.card
  if (name === 'read_image') return 'image'
  if (card === 'terminal' || SHELL_NAMES.has(name)) return 'shell'
  if (card === 'read' || name === 'read') return 'read'
  if (name === 'ls' || name === 'list') return 'list'
  if (name === 'web_search' || name === 'websearch') return 'web'
  if (name === 'web_fetch' || name === 'webfetch') return 'fetch'
  return 'search'
}

/** Hash input for the visible-rows cache: tool statuses land in place, and
 *  a status change can split a run or fold a member. */
export function toolGroupCode(tool: ToolRow): number {
  return (tool.status === 'running' ? 1 : tool.status === 'error' ? 2 : 3) + (toolGroupable(tool) ? 4 : 0)
}

/**
 * Fold runs of consecutive groupable tool calls in `out` (in place, on
 * shallow copies — rows may arrive frozen). A lone call is a run of one: the
 * summary line is the call's only shape from its first frame, so a second
 * call changes a count instead of swapping a card for a summary. Thinking
 * rows after a call join the run too, trailing ones included: drawn on their
 * own they would sit under the summary until the next call folded them
 * away. The head row carries the summary; every other member is added to
 * `foldedMembers`, running calls included. A click on the summary
 * (expandedRows) or Ctrl+O unfolds the run.
 */
export function foldToolRuns(
  out: ChatRow[],
  expanded: boolean,
  expandedRows: ReadonlySet<number>,
  foldedMembers: Set<number>,
): void {
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.kind !== 'tool' || !toolGroupable(out[i]!.tool)) continue
    let end = i
    for (let k = i + 1; k < out.length; k++) {
      const next = out[k]!
      if ((next.kind === 'tool' && toolGroupable(next.tool)) || next.kind === 'reasoning') end = k
      else break
    }
    const kinds = new Map<ToolGroupKind, { count: number; live: boolean }>()
    let size = 0
    for (let k = i; k <= end; k++) {
      const tool = out[k]!.kind === 'tool' ? out[k]!.tool : undefined
      if (tool === undefined) continue
      size++
      const kind = toolKind(tool)
      const entry = kinds.get(kind) ?? { count: 0, live: false }
      entry.count++
      entry.live = entry.live || tool.status === 'running'
      kinds.set(kind, entry)
    }
    const folded = !expanded && !expandedRows.has(out[i]!.id)
    const summary = {
      folded,
      size,
      kinds: [...kinds].map(([kind, { count, live }]) => ({ kind, count, live })),
    }
    for (let k = i; k <= end; k++) {
      const row = out[k]!
      out[k] = { ...row, toolGroup: { ...summary, head: k === i } }
      if (folded && k > i) foldedMembers.add(row.id)
    }
    i = end
  }
}

const KIND_KEYS: Record<ToolGroupKind, readonly [done: I18nKey, live: I18nKey]> = {
  shell: ['tool-run-shell', 'tool-run-shell-live'],
  read: ['tool-run-read', 'tool-run-read-live'],
  image: ['tool-run-image', 'tool-run-image-live'],
  search: ['tool-run-search', 'tool-run-search-live'],
  list: ['tool-run-list', 'tool-run-list-live'],
  web: ['tool-run-web', 'tool-run-web-live'],
  fetch: ['tool-run-fetch', 'tool-run-fetch-live'],
}

/**
 * The summary sentence, in the kinds' first-seen order:
 *
 *   Ran 2 shell commands
 *   Read 2 files, running 1 shell command…      (a call still running)
 *
 * A kind with a call still running reads in the progressive and the line
 * ends in `…`; when the call settles only that clause changes.
 */
export function toolGroupSummary(group: Pick<ToolGroupRow, 'kinds'>): string {
  const parts = group.kinds.map(({ kind, count, live }) => t(KIND_KEYS[kind][live ? 1 : 0], { count }))
  const text = parts.join(t('tool-run-join'))
  const sentence = text.charAt(0).toUpperCase() + text.slice(1)
  return group.kinds.some(entry => entry.live) ? `${sentence}…` : sentence
}

/**
 * Summary line of a tool run (`row.toolGroup` on its head): one dim line
 * aligned with the transcript text, like `Ran 2 shell commands`. Clicking
 * it toggles the run, the same gesture as the job-group header.
 */
export function ToolGroupHeader({ group, onToggle }: { group: ToolGroupRow; onToggle?(): void }): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  return (
    <Box
      flexDirection="row"
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* The bullet column of the rows around it, left blank. */}
      <Box flexShrink={0} width={2} />
      <Text wrap="truncate-end" dimColor={!hovered}>{toolGroupSummary(group)}</Text>
    </Box>
  )
}
