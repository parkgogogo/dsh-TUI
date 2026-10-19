import React from 'react'
import { Box, Text, useAnimationFrame } from '../../ui.js'
import type { ChatRow, ToolGroupRow, ToolRow } from '../../adapter/ports/channel-view.js'
import { formatDuration } from '../../terminal-utils/format.js'
import { t } from '../../i18n.js'
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

/** Name a call counts under on the summary line (`Read image`, `Bash`). */
function toolLabel(tool: ToolRow): string {
  return displayName(tool.name, (tool.resultView ?? tool.callView)?.displayKey).replace(/_/g, ' ')
}

/** The call's own text for the summary line: a terminal command as is; a
 *  card title that opens with the tool's name (`Read x.txt`, `Read image
 *  pic.png`) loses it — the line already names the tool. First line only. */
function summaryTitle(tool: ToolRow): string | undefined {
  const title = (tool.resultView?.title ?? tool.callView?.title)?.split('\n', 1)[0]?.trim()
  if (title === undefined) return undefined
  const label = toolLabel(tool)
  return title.toLowerCase().startsWith(`${label.toLowerCase()} `) ? title.slice(label.length + 1).trim() : title
}

/** Length of the union of `[start, end]` spans: parallel calls count once. */
function unionMs(spans: Array<[number, number]>): number {
  spans.sort((a, b) => a[0] - b[0])
  let total = 0
  let from = -Infinity
  let to = -Infinity
  for (const [start, end] of spans) {
    if (start > to) {
      if (to > from) total += to - from
      from = start
      to = end
    } else if (end > to) {
      to = end
    }
  }
  if (to > from) total += to - from
  return total
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
 * call bumps a count instead of swapping a card for a summary. Thinking rows
 * after a call join the run too, trailing ones included: drawn on their own
 * they would sit under the summary until the next call folded them away, so
 * live thinking shows on the summary line instead. The head row carries the
 * summary; every other member is added to `foldedMembers`, running calls
 * included — the summary shows the live call. A click on the summary
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
    const tools: ToolRow[] = []
    for (let k = i; k <= end; k++) {
      const tool = out[k]!.kind === 'tool' ? out[k]!.tool : undefined
      if (tool !== undefined) tools.push(tool)
    }
    const names = new Map<string, number>()
    let live: ToolRow | undefined
    let runningSince: number | undefined
    const spans: Array<[number, number]> = []
    for (const tool of tools) {
      const name = toolLabel(tool)
      names.set(name, (names.get(name) ?? 0) + 1)
      if (tool.status === 'running') {
        live = tool
        runningSince = Math.min(runningSince ?? tool.startedAt, tool.startedAt)
      } else {
        spans.push([tool.startedAt, tool.startedAt + (tool.durationMs ?? 0)])
      }
    }
    const shown = live ?? (tools.length === 1 ? tools[0] : undefined)
    const title = shown === undefined ? undefined : summaryTitle(shown)
    const folded = !expanded && !expandedRows.has(out[i]!.id)
    const summary = {
      folded,
      names: [...names],
      settledMs: unionMs(spans),
      size: tools.length,
      ...(runningSince === undefined ? {} : { runningSince }),
      ...(title === undefined || title === '' ? {} : { title }),
      ...(out[end]!.kind === 'reasoning' && out[end]!.streaming === true ? { thinking: true } : {}),
    }
    for (let k = i; k <= end; k++) {
      const row = out[k]!
      out[k] = { ...row, toolGroup: { ...summary, head: k === i } }
      if (folded && k > i) foldedMembers.add(row.id)
    }
    i = end
  }
}

/**
 * Summary line of a tool run (`row.toolGroup` on its head):
 *
 *   ▸ Bash · 1s · sleep 5                    (a lone call)
 *   ▸ Bash ×6 · Read ×2 · 14s · sleep 5      (a call still running)
 *   ▸ Bash ×5 · Read ×2 · 12s · Thinking…   (thinking after the last call)
 *   ▸ Bash ×5 · Read ×2 · 12s
 *
 * The duration is the time the calls spent running (what their cards' chips
 * add up to; the model's gaps between calls are left out). While a call runs
 * it ticks and the live command trails it (cut first when the row is narrow). Clicking the line
 * toggles the run, the same gesture as the job-group header.
 */
export function ToolGroupHeader({ group, onToggle }: { group: ToolGroupRow; onToggle?(): void }): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const live = group.runningSince !== undefined
  // 1 s tick while a call runs; elapsed derives from the wall clock.
  const [ref] = useAnimationFrame(live ? 1000 : null)
  const names = group.names.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(' · ')
  const runningMs = group.runningSince === undefined ? 0 : Math.max(0, Date.now() - group.runningSince)
  const duration = ` · ${formatDuration(group.settledMs + runningMs)}`
  const title = group.title === undefined ? '' : ` · ${group.title}`
  const thinking = group.thinking === true && !live ? ` · ${t('thinking-label')}…` : ''
  return (
    <Box
      ref={ref}
      flexDirection="row"
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* A fixed column: a narrow row truncates the text, never this gap. */}
      <Box flexShrink={0} width={2}>
        <Text color={hovered ? 'accent' : 'inactive'}>{group.folded ? '▸' : '▾'}</Text>
      </Box>
      <Text wrap="truncate-end" dimColor={!hovered}>{names + duration + title + thinking}</Text>
    </Box>
  )
}
