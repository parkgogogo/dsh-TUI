import React from 'react'
import { Box, Text } from '../../ui.js'
import type { ChatRow, ToolGroupRow, ToolRow } from '../../adapter/ports/channel-view.js'
import { formatDuration } from '../../terminal-utils/format.js'
import { displayName } from '../messages/AssistantToolUseMessage.js'

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

/** Hash input for the visible-rows cache: tool statuses land in place, and
 *  a status change can split a run or fold a member. */
export function toolGroupCode(tool: ToolRow): number {
  return (tool.status === 'running' ? 1 : tool.status === 'error' ? 2 : 3) + (toolGroupable(tool) ? 4 : 0)
}

/**
 * Fold runs of ≥2 consecutive groupable tool calls in `out` (in place, on
 * shallow copies — rows may arrive frozen). Settled thinking rows between the
 * calls join the run; trailing ones stay outside it. The head row carries the
 * summary; every other member is added to `foldedMembers` unless it is still
 * running. A click on the summary (expandedRows) or Ctrl+O unfolds the run.
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
      if (next.kind === 'tool' && toolGroupable(next.tool)) end = k
      else if (next.kind !== 'reasoning' || next.streaming === true) break
    }
    const tools: ToolRow[] = []
    for (let k = i; k <= end; k++) {
      const tool = out[k]!.kind === 'tool' ? out[k]!.tool : undefined
      if (tool !== undefined) tools.push(tool)
    }
    if (tools.length < 2) {
      i = end
      continue
    }
    const names = new Map<string, number>()
    let endedAt = 0
    let live = false
    for (const tool of tools) {
      const name = displayName(tool.name, (tool.resultView ?? tool.callView)?.displayKey).replace(/_/g, ' ')
      names.set(name, (names.get(name) ?? 0) + 1)
      live = live || tool.status === 'running'
      endedAt = Math.max(endedAt, tool.startedAt + (tool.durationMs ?? 0))
    }
    const folded = !expanded && !expandedRows.has(out[i]!.id)
    const summary = {
      folded,
      names: [...names],
      startedAt: tools[0]!.startedAt,
      ...(live ? {} : { endedAt }),
    }
    for (let k = i; k <= end; k++) {
      const row = out[k]!
      out[k] = { ...row, toolGroup: { ...summary, head: k === i } }
      if (folded && k > i && !(row.kind === 'tool' && row.tool?.status === 'running')) foldedMembers.add(row.id)
    }
    i = end
  }
}

/**
 * Summary line of a tool run (`row.toolGroup` on its head):
 *
 *   ▸ Bash ×5 · Read ×2 · 12s
 *
 * The duration appears once every call settled. Clicking the line toggles
 * the run, the same gesture as the job-group header.
 */
export function ToolGroupHeader({ group, onToggle }: { group: ToolGroupRow; onToggle?(): void }): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const names = group.names.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(' · ')
  const duration = group.endedAt === undefined ? '' : ` · ${formatDuration(Math.max(0, group.endedAt - group.startedAt))}`
  return (
    <Box
      flexDirection="row"
      gap={1}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Text color={hovered ? 'accent' : 'inactive'}>{group.folded ? '▸' : '▾'}</Text>
      <Text wrap="truncate-end" dimColor={!hovered}>{names + duration}</Text>
    </Box>
  )
}
