/**
 * Compact tool runs (settings `dsh-tui.compactTools`, src/components/Chat/
 * ToolGroup.tsx): foldToolRuns on fabricated rows. A lone groupable call is
 * already a run of one, so the summary line keeps one shape from the first
 * frame on; failures, edits and assistant text break a run; thinking after a
 * call joins it; the duration counts parallel calls once and leaves the
 * model's gaps out; frozen rows are never written.
 */
import assert from 'node:assert/strict'
import { foldToolRuns } from '../src/components/Chat/ToolGroup.js'
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

ok('lone running call is a run of one with its command', () => {
  const { heads, folded } = run([bash('sleep 5', { status: 'running', start: 1000 })])
  assert.equal(heads.length, 1); const g = heads[0]!.toolGroup!
  assert.equal(g.size, 1); assert.equal(g.title, 'sleep 5'); assert.equal(g.runningSince, 1000); assert.equal(folded.size, 0)
})
ok('lone settled call keeps its command, no running clock', () => {
  const g = run([bash('ls', { dur: 300 })]).heads[0]!.toolGroup!
  assert.equal(g.title, 'ls'); assert.equal(g.runningSince, undefined); assert.equal(g.settledMs, 300)
})
ok('second call bumps the count; running one folds; title is the live one', () => {
  const { heads, folded, out } = run([bash('a', { start: 0, dur: 100 }), bash('b', { status: 'running', start: 500 })])
  assert.equal(heads.length, 1); const g = heads[0]!.toolGroup!
  assert.deepEqual(g.names, [['Bash', 2]]); assert.equal(g.title, 'b'); assert.ok(folded.has(out[1]!.id))
})
ok('settled run of many shows no title; time is union (model gaps excluded)', () => {
  const g = run([bash('a', { start: 0, dur: 1000 }), bash('b', { start: 5000, dur: 1000 })]).heads[0]!.toolGroup!
  assert.equal(g.title, undefined); assert.equal(g.settledMs, 2000)
})
ok('parallel calls count once', () => {
  const g = run([bash('a', { start: 0, dur: 1000 }), bash('b', { start: 100, dur: 1000 }), bash('c', { start: 200, dur: 100 })]).heads[0]!.toolGroup!
  assert.equal(g.settledMs, 1100)
})
ok('non-zero exit splits the run and keeps its own card', () => {
  const rows = [bash('a'), bash('ls /x', { exit: 1 }), bash('b')]
  const { heads, out } = run(rows)
  assert.equal(heads.length, 2); assert.equal(out[1]!.toolGroup, undefined)
})
ok('assistant text breaks a run', () => {
  assert.equal(run([bash('a'), say('hello'), bash('b')]).heads.length, 2)
})
ok('thinking between and after calls joins; streaming tail marks thinking', () => {
  const { heads, folded, out } = run([bash('a'), think(), bash('b'), think(true)])
  assert.equal(heads.length, 1); assert.equal(heads[0]!.toolGroup!.thinking, true)
  assert.ok(folded.has(out[1]!.id) && folded.has(out[3]!.id))
})
ok('leading thinking stays outside the run', () => {
  const { out, folded } = run([think(), bash('a'), bash('b')])
  assert.equal(out[0]!.toolGroup, undefined); assert.ok(!folded.has(out[0]!.id))
})
ok('read title drops the tool name; mixed names in first-seen order', () => {
  const { heads } = run([read('x.txt')]); assert.equal(heads[0]!.toolGroup!.title, 'x.txt')
  const g = run([read('x.txt'), bash('ls'), read('y.txt')]).heads[0]!.toolGroup!
  assert.deepEqual(g.names, [['Read', 2], ['Bash', 1]])
})
ok('Ctrl+O and a row click unfold (nothing folded)', () => {
  const rows = [bash('a'), bash('b')]
  assert.equal(run(rows, true).folded.size, 0); assert.equal(run(rows, true).heads[0]!.toolGroup!.folded, false)
  const head = rows[0]!.id
  assert.equal(run(rows, false, [head]).folded.size, 0)
})
ok('frozen input rows are never written', () => {
  const rows = [bash('a'), bash('b')].map(r => Object.freeze(r))
  const out = [...rows]; foldToolRuns(out, false, new Set(), new Set())
  assert.equal((rows[0] as ChatRow).toolGroup, undefined)
})
console.log(`verify:tool-group OK (${n} cases)`)
