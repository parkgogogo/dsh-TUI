/**
 * Compact tool runs (settings `dsh-tui.compactTools`, src/components/Chat/
 * ToolGroup.tsx): foldToolRuns on fabricated rows. A lone groupable call is
 * already a run of one, so the summary line keeps one shape from the first
 * frame on; failures, edits and assistant text break a run; thinking after a
 * call joins it; frozen rows are never written. toolGroupSummary renders the
 * summary sentence (`Read 2 files, ran 1 shell command`).
 */
process.env.DSH_TUI_LANG = 'en'
import assert from 'node:assert/strict'
import { foldToolRuns, toolGroupSummary } from '../src/components/Chat/ToolGroup.js'
import type { ChatRow } from '../src/adapter/ports/channel-view.js'

let id = 0
const bash = (cmd: string, o: Partial<{ status: 'running' | 'ok' | 'error'; start: number; dur: number; exit: number }> = {}): ChatRow => ({
  id: ++id, kind: 'tool', text: '',
  tool: {
    callId: `c${id}`, name: 'bash', argsText: '', status: o.status ?? 'ok', startedAt: o.start ?? 0,
    ...(o.status === 'running' ? {} : { durationMs: o.dur ?? 0 }),
    callView: { card: 'terminal', title: cmd },
    ...(o.exit === undefined ? {} : { resultView: { card: 'terminal', title: cmd, exitCode: o.exit } }),
  },
} as ChatRow)
const read = (path: string): ChatRow => ({ id: ++id, kind: 'tool', text: '', tool: { callId: `c${id}`, name: 'read', argsText: '', status: 'ok', startedAt: 0, durationMs: 0, callView: { card: 'read', title: `Read ${path}` } } } as ChatRow)
const image = (): ChatRow => ({ id: ++id, kind: 'tool', text: '', tool: { callId: `c${id}`, name: 'read_image', argsText: '', status: 'ok', startedAt: 0, durationMs: 0 } } as ChatRow)
const grep = (): ChatRow => ({ id: ++id, kind: 'tool', text: '', tool: { callId: `c${id}`, name: 'grep', argsText: '', status: 'ok', startedAt: 0, durationMs: 0 } } as ChatRow)
const think = (streaming = false): ChatRow => ({ id: ++id, kind: 'reasoning', text: 'x', ...(streaming ? { streaming: true } : {}) } as ChatRow)
const say = (text: string): ChatRow => ({ id: ++id, kind: 'assistant', text } as ChatRow)
const run = (rows: ChatRow[], expanded = false, open: number[] = []) => {
  const out = rows.map(r => Object.freeze({ ...r })) as ChatRow[]
  const folded = new Set<number>()
  foldToolRuns(out, expanded, new Set(open), folded)
  return { out, folded, heads: out.filter(r => r.toolGroup?.head) }
}
let n = 0
const ok = (name: string, f: () => void) => { f(); n++; console.log('ok  ', name) }
const line = (rows: ChatRow[]) => toolGroupSummary(run(rows).heads[0]!.toolGroup!)

ok('lone running call is a run of one, live sentence', () => {
  const { heads, folded } = run([bash('sleep 5', { status: 'running' })])
  assert.equal(heads.length, 1); assert.equal(heads[0]!.toolGroup!.size, 1); assert.equal(folded.size, 0)
  assert.equal(toolGroupSummary(heads[0]!.toolGroup!), 'Running 1 shell command…')
})
ok('settled lone call: past tense, singular', () => {
  assert.equal(line([bash('ls')]), 'Ran 1 shell command')
})
ok('second call only changes the count; running member folds', () => {
  const { heads, folded, out } = run([bash('a'), bash('b', { status: 'running' })])
  assert.equal(heads.length, 1); assert.ok(folded.has(out[1]!.id))
  assert.equal(toolGroupSummary(heads[0]!.toolGroup!), 'Running 2 shell commands…')
  assert.equal(line([bash('a'), bash('b')]), 'Ran 2 shell commands')
})
ok('kinds in first-seen order; only the running kind is progressive', () => {
  assert.equal(line([read('x.txt'), read('y.txt'), bash('ls', { status: 'running' })]), 'Read 2 files, running 1 shell command…')
  assert.equal(line([read('x.txt'), bash('ls'), read('y.txt')]), 'Read 2 files, ran 1 shell command')
  assert.equal(line([grep(), image(), bash('ls')]), 'Searched for 1 pattern, viewed 1 image, ran 1 shell command')
})
ok('non-zero exit splits the run and keeps its own card', () => {
  const { heads, out } = run([bash('a'), bash('ls /x', { exit: 1 }), bash('b')])
  assert.equal(heads.length, 2); assert.equal(out[1]!.toolGroup, undefined)
})
ok('assistant text breaks a run', () => {
  assert.equal(run([bash('a'), say('hello'), bash('b')]).heads.length, 2)
})
ok('thinking between and after calls joins the run', () => {
  const { heads, folded, out } = run([bash('a'), think(), bash('b'), think(true)])
  assert.equal(heads.length, 1); assert.equal(heads[0]!.toolGroup!.size, 2)
  assert.ok(folded.has(out[1]!.id) && folded.has(out[3]!.id))
})
ok('leading thinking stays outside the run', () => {
  const { out, folded } = run([think(), bash('a'), bash('b')])
  assert.equal(out[0]!.toolGroup, undefined); assert.ok(!folded.has(out[0]!.id))
})
ok('Ctrl+O and a row click unfold (nothing folded)', () => {
  const rows = [bash('a'), bash('b')]
  assert.equal(run(rows, true).folded.size, 0); assert.equal(run(rows, true).heads[0]!.toolGroup!.folded, false)
  assert.equal(run(rows, false, [rows[0]!.id]).folded.size, 0)
})
ok('frozen input rows are never written', () => {
  const rows = [bash('a'), bash('b')].map(r => Object.freeze(r))
  const out = [...rows]; foldToolRuns(out, false, new Set(), new Set())
  assert.equal((rows[0] as ChatRow).toolGroup, undefined)
})
console.log(`verify:tool-group OK (${n} cases)`)
