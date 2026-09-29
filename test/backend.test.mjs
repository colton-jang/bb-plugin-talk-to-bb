// Created: 2026-09-28. Backend model settings and the per-lookup timing log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, TalkSession, DEFAULT_BACKEND, backendOptions } from '../live-session.mjs';
import { LookupTimer, timingLine } from '../backend-timing.mjs';

test('defaults are unchanged: gpt-6-sol in this fork, no reasoning or service tier sent', () => {
  const r = config({}).delegation.responses;
  assert.equal(r.model, 'gpt-6-sol');
  assert.equal(DEFAULT_BACKEND.model, 'gpt-6-sol');
  assert.equal('reasoning' in r, false);
  assert.equal('service_tier' in r, false);
});

test('model, effort and tier are passed in the delegation schema shape', () => {
  const r = config({}, { backend: { model: 'gpt-5.6-luna', reasoning: 'low', serviceTier: 'priority' } }).delegation.responses;
  assert.equal(r.model, 'gpt-5.6-luna');
  assert.deepEqual(r.reasoning, { effort: 'low' });
  assert.equal(r.service_tier, 'priority');
});

test('unknown or empty values fall back to the defaults instead of breaking the call', () => {
  assert.deepEqual(backendOptions({ model: '', reasoning: 'turbo', serviceTier: 'fastest' }), { model: 'gpt-6-sol', reasoning: '', serviceTier: '' });
  assert.deepEqual(backendOptions({ model: ' gpt-6-luna ', reasoning: ' High ' }), { model: 'gpt-6-luna', reasoning: 'high', serviceTier: '' });
  assert.equal(backendOptions({ model: 'bad model; rm' }).model, 'gpt-6-sol');
});

test('the session starts with the configured backend', () => {
  const sent = [];
  const session = new TalkSession({ key: 'k', query: async () => ({}), backend: { model: 'gpt-6-luna', reasoning: 'none' },
    Socket: class { constructor() { this.readyState = 1; } on(type, fn) { if (type === 'open') setImmediate(fn); } send(v) { sent.push(JSON.parse(v)); } close() {} terminate() {} } });
  session.start();
  return new Promise(resolve => setImmediate(() => {
    const r = sent[0].session.delegation.responses;
    assert.equal(r.model, 'gpt-6-luna'); assert.deepEqual(r.reasoning, { effort: 'none' });
    session.clear(); clearTimeout(session.startup); resolve();
  }));
});

test('one timing record per lookup: first tool, each tool, answer, tokens', async () => {
  const records = [];
  const sent = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const session = new TalkSession({ key: 'k', backend: { model: 'gpt-5.6-luna', reasoning: 'low' }, query: async name => { await gate; return { name }; } });
  session.on('timing', r => records.push(r));
  session.socket = { readyState: 1, bufferedAmount: 0, send: v => sent.push(JSON.parse(v)), close() {}, terminate() {} };
  session.ready = true;
  const env = (event, id = 'del_1') => ({ type: 'response.event', delegation_id: id, event });
  session.handle(env({ type: 'response.created', response: { id: 'r1' } }));
  session.handle(env({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'a', name: 'bb_search', arguments: '{}' } }));
  session.handle(env({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'b', name: 'bb_overview', arguments: '{}' } }));
  session.handle(env({ type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } } } }));
  assert.equal(records.length, 0, 'tool calls continue the lookup');
  release();
  await new Promise(r => setImmediate(r));
  assert.equal(sent.at(-1).type, 'response.create');
  // The continued round arrives under a different delegation id and still belongs to this lookup.
  session.handle(env({ type: 'response.created', response: { id: 'r2' } }, 'del_2'));
  session.handle(env({ type: 'response.output_text.delta', delta: 'Two' }, 'del_2'));
  session.handle(env({ type: 'response.completed', response: { id: 'r2', usage: { input_tokens: 300, output_tokens: 40 } } }, 'del_2'));
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.outcome, 'answered'); assert.equal(r.model, 'gpt-5.6-luna'); assert.equal(r.effort, 'low'); assert.equal(r.tier, 'default');
  assert.equal(r.rounds, 2);
  assert.deepEqual(r.tools.map(t => t.name), ['bb_search', 'bb_overview']);
  assert.ok(r.tools.every(t => t.ok === true));
  assert.ok(r.firstToolMs !== null && r.firstToolMs <= r.totalMs);
  assert.deepEqual(r.usage, { input: 400, cached: 80, written: 15, output: 60, reasoning: 5 });
  assert.match(timingLine(r), /cache-write 15/);
  assert.equal(r.modelMs + r.toolMs, r.totalMs);
  assert.match(timingLine(r), /^backend lookup del_1: gpt-5\.6-luna effort=low tier=default answered \| first-tool \d+ms \| tools bb_search \d+ms, bb_overview \d+ms \| answer \d+ms/);
  session.clear();
});

test('a direct answer, a failure and a cut-off each produce exactly one record', () => {
  let t = 0;
  const records = [];
  const timer = new LookupTimer({ backend: DEFAULT_BACKEND, now: () => t, onRecord: r => records.push(r) });
  timer.created('d1'); t = 900; timer.text('d1'); t = 1200; timer.completed('d1', { hasCalls: false });
  timer.created('d2'); t = 1500; timer.failed('d2');
  timer.created('d3'); t = 1600; timer.toolStarted('d3', 'c', 'bb_read_thread'); t = 2000; timer.flush();
  assert.deepEqual(records.map(r => r.outcome), ['answered', 'failed', 'cut-off']);
  assert.equal(records[0].firstTextMs, 900); assert.equal(records[0].firstToolMs, null); assert.equal(records[0].totalMs, 1200);
  assert.equal(records[0].effort, 'default');
  assert.equal(records[2].toolMs, 400);
  assert.match(timingLine(records[0]), /tools none/);
});

test('parallel tools count once toward tool time', () => {
  let t = 0;
  const records = [];
  const timer = new LookupTimer({ backend: DEFAULT_BACKEND, now: () => t, onRecord: r => records.push(r) });
  timer.created('d'); t = 100;
  timer.toolStarted('d', 'a', 'x'); timer.toolStarted('d', 'b', 'y');
  t = 600; timer.toolDone('d', 'a', true); t = 1100; timer.toolDone('d', 'b', false);
  timer.completed('d', { hasCalls: true }); timer.continued('d');
  timer.created('d'); t = 1500; timer.completed('d', {});
  assert.equal(records[0].toolMs, 1000); assert.equal(records[0].modelMs, 500);
  assert.match(timingLine(records[0]), /y 1000ms FAILED/);
});

test('the standing context trim: full is unchanged, brief stops at the background snapshots, off is empty', async () => {
  const { trimOperatingContext, operatingBriefing } = await import('../operating-context.mjs');
  const ctx = { state: 'fresh', ageHours: 1, text: 'DURABLE GOALS:\n1. Grow sales.\nBOUNDARIES:\n- Drafts only.\nBACKGROUND REFERENCE (ok).\n- Board: 11 cards' };
  assert.equal(trimOperatingContext(ctx), ctx);
  assert.equal(trimOperatingContext(ctx, 'nonsense'), ctx);
  const brief = trimOperatingContext(ctx, 'brief');
  assert.match(brief.text, /Drafts only\.$/); assert.doesNotMatch(brief.text, /Board/);
  assert.equal(operatingBriefing(trimOperatingContext(ctx, 'off')), '');
  const noMarker = trimOperatingContext({ ...ctx, text: 'x'.repeat(4000) }, 'brief');
  assert.equal(noMarker.text.length, 2500);
});

test('the lean phone tool set drops browser, screen, review, direct-line and capability tools only', async () => {
  const { backendTools, LEAN_DROPPED } = await import('../live-session.mjs');
  const names = options => config({}, options).delegation.responses.tools[0].parameters.properties.name.enum;
  const full = names({});
  assert.deepEqual(full, backendTools().map(t => t.name), 'default is the full set');
  const lean = names({ toolset: 'lean' });
  assert.doesNotMatch(config({}, { toolset: 'lean' }).delegation.responses.instructions, /bb_view_screen\(/, 'the lean catalog lists only lean operations');
  for (const name of ['bb_overview', 'bb_search', 'bb_read_thread', 'bb_tell_thread', 'bb_spawn_thread', 'bb_execution_options', 'bb_note_commitment', 'bb_recall_thoughts', 'bb_capture_thought'])
    assert.ok(lean.includes(name), name);
  for (const name of ['bb_view_screen', 'bb_focus_thread', 'bb_talk_to_worker', 'bb_find_capability', 'bb_review_start'])
    assert.ok(!lean.includes(name), name);
  assert.equal(lean.length, full.length - LEAN_DROPPED.size);
});

test('the fast tier is sent to GPT-Live as priority (its delegation schema rejects "fast")', async () => {
  const { config } = await import('../live-session.mjs');
  const c = config({ threadId: null, projectId: null }, { backend: { model: 'gpt-5.6-luna', reasoning: 'none', serviceTier: 'fast' } });
  assert.equal(c.delegation.responses.service_tier, 'priority');
});

test('a lean read budget caps what a thread read hands the voice backend', async () => {
  const { createReader, READ_BUDGETS } = await import('../bb-read.mjs');
  assert.ok(READ_BUDGETS.lean.conversation < READ_BUDGETS.full.conversation);
  const long = 'x'.repeat(30000);
  const run = async (_cmd, args) => {
    const a = args.join(' ');
    if (a.includes('thread show')) return { stdout: JSON.stringify({ thread: { id: 'thr_aaaaaaaaaa', title: 'T', status: 'idle' }, pendingTodos: [] }) };
    if (a.includes('thread log')) return { stdout: long };
    return { stdout: '[]' };
  };
  for (const [budget, max] of [['lean', READ_BUDGETS.lean.conversation], ['full', READ_BUDGETS.full.conversation]]) {
    const out = await createReader({ cliPath: 'bb', serverUrl: 'http://x', run, budget })('bb_read_thread', { threadId: 'thr_aaaaaaaaaa', turns: 6 });
    assert.equal(out.conversation.length, max);
    assert.equal(out.conversationTruncated, true);
  }
});

test('a thread read can page back through older history, one budget at a time', async () => {
  const { createReader, READ_BUDGETS } = await import('../bb-read.mjs');
  const cap = READ_BUDGETS.lean.conversation;
  const log = 'A'.repeat(cap) + 'B'.repeat(cap) + 'C'.repeat(cap);
  const limits = [];
  const run = async (_cmd, args) => {
    const a = args.join(' ');
    if (a.includes('thread show')) return { stdout: JSON.stringify({ thread: { id: 'thr_aaaaaaaaaa', title: 'T', status: 'idle' }, pendingTodos: [] }) };
    if (a.includes('thread log')) { limits.push(args[args.indexOf('--limit') + 1]); return { stdout: log }; }
    return { stdout: '[]' };
  };
  const read = createReader({ cliPath: 'bb', serverUrl: 'http://x', run, budget: 'lean' });
  const newest = await read('bb_read_thread', { threadId: 'thr_aaaaaaaaaa', turns: 6 });
  assert.equal(newest.conversation, 'C'.repeat(cap)); assert.equal(newest.nextOlderBy, cap);
  const older = await read('bb_read_thread', { threadId: 'thr_aaaaaaaaaa', turns: 6, olderBy: newest.nextOlderBy });
  assert.equal(older.conversation, 'B'.repeat(cap)); assert.equal(older.nextOlderBy, 2 * cap);
  const oldest = await read('bb_read_thread', { threadId: 'thr_aaaaaaaaaa', turns: 6, olderBy: older.nextOlderBy });
  assert.equal(oldest.conversation, 'A'.repeat(cap)); assert.equal(oldest.nextOlderBy, undefined);
  assert.deepEqual(limits, ['6', '40', '40'], 'paging back reads a longer log');
});
