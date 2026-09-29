// Created: 2026-09-27. Ambient Walk: digest batching, urgency, dedupe, quiet hours, persistence, thought capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbientBatcher, AMBIENT_DEFAULTS, classify, inQuietHours, deliveryText, workerSignal, createAmbient,
  captureThought, listThoughts, thoughtInput, ambientInput, ambientRpc, thoughtRpc, createThoughtTool, withThoughtTool,
  thoughtDefinitions, THOUGHT_ACK } from '../ambient.mjs';
import { UserRequests, recentReceipts } from '../bb-manager.mjs';
import { buildContinuity } from '../reliability.mjs';
import { config, backendInstructions } from '../live-session.mjs';
// Colton's fork sends one compact bb_call tool; the operations it can name are its enum.
const offered = (options = {}) => config({}, options).delegation.responses.tools[0].parameters.properties.name.enum;

function memory({ dropWrites = false } = {}) {
  const map = new Map();
  return { map,
    get: async key => map.has(key) ? structuredClone(map.get(key)) : undefined,
    set: async (key, value) => { if (!dropWrites) map.set(key, structuredClone(value)); },
    list: async prefix => [...map.keys()].filter(k => k.startsWith(prefix)),
  };
}
const MIN = 60000;
// 2026-09-27 10:00 at UTC-10: well outside the default quiet hours.
const T0 = Date.parse('2026-09-27T20:00:00Z');
const ZONE = 'Etc/GMT+10'; // UTC-10, no daylight saving
const worker = (id, state, extra = {}) => ({ kind: 'worker', subject: `thread:${id}`, threadId: id, title: `Thread ${id}`, state, version: extra.version ?? 'v1', awaited: false, ...extra });
function walk(options = {}) {
  let now = T0;
  const b = new AmbientBatcher({ timeZone: ZONE, clock: () => now, ...options });
  b.start(now);
  return { b, at: ms => { now = T0 + ms; return now; }, get now() { return now; } };
}

test('urgent criteria: awaited reply or failure, an approval only the user can answer, a deadline inside the hour', () => {
  const now = T0;
  assert.equal(classify(worker('a', 'replied', { awaited: true }), { now }).level, 'urgent');
  assert.equal(classify(worker('a', 'failed', { awaited: true }), { now }).level, 'urgent');
  assert.equal(classify(worker('a', 'needs-input'), { now }).level, 'urgent');
  assert.equal(classify(worker('a', 'replied'), { now }).level, 'digest', 'an agent nobody is waiting on replying is digest news');
  assert.equal(classify(worker('a', 'failed'), { now }).level, 'digest');
  const due = min => ({ kind: 'deadline', subject: 'deadline:x', dueAt: new Date(now + min * MIN).toISOString() });
  assert.equal(classify(due(45), { now }).level, 'urgent');
  assert.equal(classify(due(-10), { now }).level, 'urgent', 'just missed still interrupts');
  assert.equal(classify(due(90), { now }).level, 'digest');
  assert.equal(classify(due(-30), { now }).level, 'digest', 'long overdue waits for the digest');
  assert.equal(classify({ kind: 'commitment', subject: 'c', title: 'x' }, { now }).level, 'digest');
});

test('ordinary news is batched: things finishing together land as one, at most every 2 minutes, and nothing new says nothing', () => {
  const w = walk();
  assert.equal(AMBIENT_DEFAULTS.intervalMs, 2 * MIN);
  assert.equal(w.b.tick(w.at(3 * MIN)).digest, null, 'no news, no check-in');
  w.b.offer(worker('a', 'replied'), w.at(3 * MIN));
  w.b.offer(worker('b', 'failed'), w.at(3 * MIN + 10000));
  assert.equal(w.b.tick(w.at(3 * MIN + 20000)).digest, null, 'still inside the batching window');
  const slot = w.b.tick(w.at(3 * MIN + 41000));
  assert.equal(slot.interrupt, null);
  assert.equal(slot.digest.count, 2);
  assert.deepEqual(slot.digest.subjects, ['thread:b', 'thread:a'], 'failures before replies');
  assert.match(slot.digest.title, /2 things/);
  assert.ok(w.b.ack(slot.digest.id));
  const empty = w.b.tick(w.at(20 * MIN));
  assert.equal(empty.digest, null, 'nothing new is silence, not "nothing new"');
  w.b.offer(worker('c', 'replied'), w.at(20 * MIN));
  w.b.offer(worker('d', 'replied'), w.at(20 * MIN + 45000));
  assert.equal(w.b.tick(w.at(20 * MIN + 60000)).digest, null, 'a new finish restarts the settle window');
  assert.equal(w.b.tick(w.at(20 * MIN + 76000)).digest.count, 2);
});

test('a big digest reads five and counts the rest', () => {
  const w = walk();
  for (let i = 0; i < 8; i++) w.b.offer(worker(`t${i}`, 'replied'), w.at(i * 1000));
  const { digest } = w.b.tick(w.at(AMBIENT_DEFAULTS.intervalMs + 1000));
  assert.equal(digest.count, 5); assert.equal(digest.more, 3);
  assert.match(digest.body, /and 3 more when you look/);
  assert.match(digest.title, /8 things/);
  assert.equal(w.b.queue.size, 3, 'the rest stay queued for the next slot');
});

test('urgent news interrupts once a burst settles, coalesced, spaced, and capped', () => {
  const w = walk();
  w.b.offer(worker('a', 'needs-input'), w.at(10000));
  w.b.offer(worker('b', 'failed', { awaited: true }), w.at(14000));
  assert.equal(w.b.tick(w.at(16000)).interrupt, null, 'still inside the coalescing window');
  const first = w.b.tick(w.at(23000)).interrupt;
  assert.equal(first.kind, 'urgent'); assert.equal(first.count, 2, 'one interruption for the burst');
  assert.match(first.title, /Heads up, 2 things/);
  w.b.ack(first.id);
  w.b.offer(worker('c', 'needs-input'), w.at(30000));
  assert.equal(w.b.tick(w.at(60000)).interrupt, null, 'never two interruptions inside the gap');
  const second = w.b.tick(w.at(23000 + AMBIENT_DEFAULTS.urgentGapMs)).interrupt;
  assert.deepEqual(second.subjects, ['thread:c']);
  w.b.ack(second.id);
  // Two more fill the cap of four in the window; the fifth waits for the digest.
  for (const [i, id] of ['d', 'e', 'f'].entries()) {
    const at = 23000 + (i + 2) * AMBIENT_DEFAULTS.urgentGapMs;
    w.b.offer(worker(id, 'needs-input'), w.at(at - 20000));
    const r = w.b.tick(w.at(at));
    if (i < 2) { assert.ok(r.interrupt, `interrupt ${i + 3}`); w.b.ack(r.interrupt.id); }
    else {
      assert.equal(r.interrupt, null, 'past the cap, urgent news does not interrupt');
      const next = r.digest ?? w.b.tick(w.at(at - 20000 + AMBIENT_DEFAULTS.settleMs)).digest;
      assert.deepEqual(next.subjects, ['thread:f'], 'it rides the next digest instead');
    }
  }
});

test('a digest slot never lands on top of an interruption and carries pending urgent news itself', () => {
  const w = walk();
  w.b.offer(worker('a', 'replied'), w.at(1 * MIN));
  const slot = AMBIENT_DEFAULTS.intervalMs;
  w.b.offer(worker('u', 'needs-input'), w.at(slot - 60000));
  const interrupt = w.b.tick(w.at(slot - 40000)).interrupt;
  assert.ok(interrupt); w.b.ack(interrupt.id);
  assert.equal(w.b.tick(w.at(slot)).digest, null, 'slot slides past the interruption gap');
  w.b.offer(worker('v', 'needs-input'), w.at(slot + 45000));
  const late = w.b.tick(w.at(slot + 45000 + AMBIENT_DEFAULTS.settleMs));
  assert.equal(late.interrupt, null);
  assert.deepEqual(late.digest.subjects, ['thread:v', 'thread:a'], 'one delivery, urgent first');
});

test('dedupe: what was spoken is never repeated, a repeated event is one event, a new reply is news', () => {
  const w = walk({ intervalMs: 2 * MIN });
  w.b.offer(worker('a', 'replied', { version: 'v1' }), w.at(1000));
  const d = w.b.tick(w.at(2 * MIN)).digest; w.b.ack(d.id);
  assert.equal(w.b.offer(worker('a', 'replied', { version: 'v1' }), w.at(3 * MIN)), 'suppressed', 'same event redelivered');
  assert.equal(w.b.offer(worker('a', 'replied', { version: 'v2' }), w.at(3 * MIN)), 'queued', 'a second reply is news');
  // Latest state wins within a batch, and awaited-ness sticks.
  w.b.offer(worker('b', 'replied', { awaited: true }), w.at(3 * MIN));
  w.b.offer(worker('b', 'failed', { version: 'v2' }), w.at(3 * MIN + 1000));
  assert.equal(w.b.queue.get('thread:b').state, 'failed');
  assert.equal(w.b.queue.get('thread:b').awaited, true);
  // A live call already said it.
  w.b.markSpoken(worker('c', 'replied'));
  assert.equal(w.b.offer(worker('c', 'replied'), w.at(3 * MIN)), 'suppressed');
});

test('an unacknowledged delivery comes back; a failed one comes back now', () => {
  const w = walk({ intervalMs: 2 * MIN });
  w.b.offer(worker('a', 'replied'), w.at(1000));
  const d = w.b.tick(w.at(2 * MIN)).digest;
  assert.equal(w.b.queue.size, 0);
  const redo = w.b.tick(w.at(2 * MIN + AMBIENT_DEFAULTS.offerTimeoutMs + 1)).digest;
  assert.deepEqual(redo.subjects, ['thread:a'], 'Pocket never confirmed it spoke, so it is offered again');
  assert.equal(w.b.ack(d.id), false, 'the timed-out id is gone');
  assert.ok(w.b.ack(redo.id, { spoken: false }));
  assert.equal(w.b.queue.has('thread:a'), true);
});

test('quiet hours wrap midnight and hold everything, urgent included, until morning', () => {
  // 23:30 and 06:59 local (UTC-10) are quiet; 07:00 and 21:59 are not.
  assert.equal(inQuietHours(Date.parse('2026-09-28T09:30:00Z'), ZONE), true, '23:30');
  assert.equal(inQuietHours(Date.parse('2026-09-28T16:59:00Z'), ZONE), true, '06:59');
  assert.equal(inQuietHours(Date.parse('2026-09-28T17:00:00Z'), ZONE), false, '07:00');
  assert.equal(inQuietHours(Date.parse('2026-09-28T07:59:00Z'), ZONE), false, '21:59');
  assert.equal(inQuietHours(T0, ZONE, null), false, 'no quiet hours configured');
  let now = Date.parse('2026-09-28T09:00:00Z'); // 23:00 local (UTC-10)
  const b = new AmbientBatcher({ timeZone: ZONE, clock: () => now });
  b.start(now);
  b.offer(worker('a', 'needs-input'), now);
  now += 20 * MIN;
  assert.deepEqual([b.tick(now).interrupt, b.tick(now).digest], [null, null]);
  now = Date.parse('2026-09-28T17:01:00Z'); // 07:01, but the walk has timed out by now
  assert.equal(b.tick(now).status.ended, 'time-limit');
});

test('worker events: children nobody assigned are dropped, receipts make a thread awaited, archived is ignored', () => {
  const thread = { id: 'thr_a', title: 'Contracts app', updatedAt: '2026-09-27T20:00:00Z' };
  assert.deepEqual(workerSignal('thread.idle', { thread }, { updates: [] }),
    { kind: 'worker', subject: 'thread:thr_a', threadId: 'thr_a', state: 'replied', awaited: false, version: thread.updatedAt, title: 'Contracts app' });
  assert.equal(workerSignal('thread.failed', { thread }, { updates: [{}] }).awaited, true);
  assert.equal(workerSignal('thread.idle', { thread: { ...thread, parentThreadId: 'thr_p' } }, { updates: [] }), null);
  assert.equal(workerSignal('interaction.pending', { thread: { ...thread, parentThreadId: 'thr_p' } }, {}).state, 'needs-input', 'an approval anywhere is the user\'s');
  assert.equal(workerSignal('thread.idle', { thread: { ...thread, archivedAt: 'x' } }, {}), null);
  assert.equal(workerSignal('thread.created', { thread }, {}), null);
});

test('stored ambient state survives a plugin reload without re-speaking or dropping news', async () => {
  const store = memory();
  let now = T0;
  const clock = () => now;
  const first = createAmbient({ store, clock, timeZone: async () => ZONE });
  assert.equal(await first.observe('thread.idle', { thread: { id: 'thr_a', title: 'A', updatedAt: 'u1' } }, { updates: [] }), 'ignored', 'off until a walk starts');
  await first.start({ intervalMs: 2 * MIN });
  assert.equal(await first.observe('thread.idle', { thread: { id: 'thr_a', title: 'A', updatedAt: 'u1' } }, { updates: [] }), 'queued');
  assert.equal(await first.observe('thread.idle', { thread: { id: 'thr_b', title: 'B', updatedAt: 'u1' } }, { updates: [{}], spoken: true }), 'spoken-live');
  now += 2 * MIN;
  const { digest } = await first.poll();
  assert.deepEqual(digest.subjects, ['thread:thr_a']);
  await first.ack(digest.id);
  await first.observe('thread.failed', { thread: { id: 'thr_c', title: 'C', updatedAt: 'u1' } }, { updates: [] });
  const second = createAmbient({ store, clock, timeZone: ZONE }); // the reload
  assert.equal((await second.status()).enabled, true);
  assert.equal((await second.status()).queued, 1);
  assert.equal(await second.observe('thread.idle', { thread: { id: 'thr_a', title: 'A', updatedAt: 'u1' } }, { updates: [] }), 'suppressed');
  assert.equal(await second.observe('thread.idle', { thread: { id: 'thr_b', title: 'B', updatedAt: 'u1' } }, { updates: [] }), 'suppressed', 'said live before the reload');
  await second.stop();
  assert.equal((await second.status()).queued, 0, 'stopping drops held news');
});

test('the ambient RPC validates its input and posts deadlines in local time', async () => {
  assert.equal(ambientInput.safeParse({ op: 'start', intervalMs: 1000 }).success, false, 'no sub-two-minute digests');
  assert.equal(ambientInput.safeParse({ op: 'ack', id: 'nope' }).success, false);
  assert.equal(ambientInput.safeParse({ op: 'poll', extra: 1 }).success, false);
  const store = memory(); let now = T0;
  const ambient = createAmbient({ store, clock: () => now, timeZone: ZONE });
  await ambientRpc(ambient, ambientInput.parse({ op: 'start' }));
  const posted = await ambientRpc(ambient, ambientInput.parse({ op: 'deadline', id: 'cal-1', title: 'Strategy call', dueAt: new Date(T0 + 40 * MIN).toISOString() }), { timeZone: ZONE });
  assert.equal(posted.result, 'queued');
  now += 10000;
  const { interrupt } = await ambientRpc(ambient, { op: 'poll' });
  assert.equal(interrupt.body, 'Strategy call is due at 10:40 AM.');
  assert.deepEqual(await ambientRpc(ambient, { op: 'ack', id: interrupt.id, spoken: true }), { acknowledged: true });
});

test('delivery text is short, never calls a reply done, and reads titles as data', () => {
  const { title, body } = deliveryText([worker('a', 'replied', { title: 'Pocket iOS' }), worker('b', 'needs-input', { title: 'Board\nrefresh' })]);
  assert.equal(title, 'BB update, 2 things');
  assert.equal(body, 'Pocket iOS replied; Board refresh needs you.');
  assert.doesNotMatch(body, /\bdone\b|finished|complete/i);
  assert.ok(deliveryText(Array.from({ length: 5 }, (_, i) => worker(`t${i}`, 'failed', { title: 'x'.repeat(400) }))).body.length <= 600);
});

test('a thought is durably captured, idempotent on retry, and verified by reading it back', async () => {
  const store = memory();
  const now = () => new Date(T0);
  const input = thoughtInput.parse({ op: 'capture', text: '  Walk digests should lead with whatever needs me  ', capturedVia: 'siri', clientId: 'siri-8f2a9c1d' });
  const saved = await thoughtRpc(store, input, { now });
  assert.equal(saved.ack, THOUGHT_ACK);
  assert.equal(saved.thought.text, 'Walk digests should lead with whatever needs me');
  const [key] = await store.list('thought:');
  assert.deepEqual({ ...(await store.get(key)), key: undefined }, { key: undefined, id: saved.thought.id, text: saved.thought.text, at: '2026-09-27T20:00:00.000Z',
    capturedAt: '2026-09-27T20:00:00.000Z', source: 'thought bubble', capturedVia: 'siri', sessionId: null, visibility: 'personal' });
  const retry = await thoughtRpc(store, input, { now });
  assert.equal(retry.reused, true); assert.equal(retry.thought.id, saved.thought.id);
  assert.equal((await store.list('thought:')).length, 1, 'a Siri retry is not a second thought');
  await thoughtRpc(store, thoughtInput.parse({ op: 'capture', text: 'Second idea' }), { now: () => new Date(T0 + 1000) });
  const { thoughts } = await thoughtRpc(store, thoughtInput.parse({ op: 'list' }));
  assert.deepEqual(thoughts.map(t => t.text), ['Second idea', 'Walk digests should lead with whatever needs me'], 'newest first');
  await assert.rejects(captureThought(memory({ dropWrites: true }), { text: 'lost' }), /could not be confirmed/);
  assert.equal(thoughtInput.safeParse({ op: 'capture', text: '   ' }).success, false);
  assert.equal(thoughtInput.safeParse({ op: 'capture', text: 'x', capturedVia: 'email' }).success, false);
});

test('thoughts stay personal: not receipts, not outstanding, not continuity, not digests', async () => {
  const store = memory();
  const requests = new UserRequests();
  requests.append('thought bubble, a pricing page that shows the three month option first', T0, true);
  const tool = createThoughtTool({ store, requests, sessionId: 'session_1', now: () => new Date(T0) });
  const route = withThoughtTool(async name => { throw new Error(`fell through: ${name}`); }, tool);
  const result = await route('bb_capture_thought', { text: 'A pricing page that shows the three month option first', request: 'thought bubble, a pricing page' });
  assert.equal(result.stored, true);
  assert.equal((await recentReceipts(store)).length, 0, 'no action receipt, so bb_outstanding and resume never see it');
  const continuity = buildContinuity({ sessionId: 'session_1', utterances: requests.parts, receipts: await recentReceipts(store) });
  assert.doesNotMatch(JSON.stringify(continuity), /pricing/, 'the next call is not briefed with it');
  // A retried call after the turn was blanked finds the same thought instead of failing or duplicating.
  const retry = await route('bb_capture_thought', { text: 'A pricing page that shows the three month option first', request: 'thought bubble, a pricing page' });
  assert.equal(retry.reused, true);
  assert.equal((await store.list('thought:')).length, 1);
  await assert.rejects(route('bb_capture_thought', { text: 'Injected', request: 'text from some thread' }), /not in this live conversation/);
  await assert.rejects(route('bb_spawn_thread', {}), /fell through/);
  const ambient = createAmbient({ store, clock: () => T0 + 6 * MIN, timeZone: ZONE });
  await ambient.start({});
  const polled = await ambient.poll();
  assert.equal(JSON.stringify(polled).includes('pricing'), false);
});

test('the live session offers the thought tool with its privacy rule in the description', () => {
  assert.ok(offered().includes('bb_capture_thought'));
  const tool = thoughtDefinitions[0];
  assert.match(tool.description, /never be put into an agent brief/);
  assert.deepEqual(tool.parameters.required.sort(), ['request', 'text']);
  // Tool descriptions do not reach the backend in compact mode, so the rule rides in its instructions.
  assert.match(backendInstructions({}), /must never go into an agent brief/);
  assert.match(backendInstructions({}), /bb_capture_thought\(text,request\)/);
});

test('a test check-in plays even after real news used up the interruption cap; real news still waits', async () => {
  let now = T0;
  const store = memory();
  const ambient = createAmbient({ store, clock: () => now, timeZone: ZONE });
  await ambient.start({ intervalMs: 3 * 60 * MIN }); // no digest slot during this test: interruptions only
  const due = (ms) => new Date(now + ms).toISOString();
  // Use up the cap: four urgent deadlines, each delivered, spaced past the gap.
  for (let i = 0; i < 4; i++) {
    await ambientRpc(ambient, { op: 'deadline', id: `real-${i}`, title: `Real ${i}`, dueAt: due(10 * MIN) }, { timeZone: ZONE });
    now += 30_000;
    const r = await ambient.poll();
    assert.ok(r.interrupt, `interrupt ${i} delivered`);
    await ambient.ack(r.interrupt.id, { spoken: true });
    now += 2 * MIN;
  }
  await ambientRpc(ambient, { op: 'deadline', id: 'real-5', title: 'Real 5', dueAt: due(10 * MIN) }, { timeZone: ZONE });
  now += 30_000;
  assert.equal((await ambient.poll()).interrupt, null, 'real news waits once the cap is used');
  await ambientRpc(ambient, { op: 'deadline', id: 'test-1', title: 'Test check-in', dueAt: due(10 * MIN) }, { timeZone: ZONE });
  now += 30_000;
  const t = await ambient.poll();
  assert.ok(t.interrupt, 'the test check-in plays');
  assert.match(t.interrupt.body, /Test check-in/);
});


test('pausing the music flushes what is waiting as one digest now; nothing waiting says nothing; quiet hours still hold', async () => {
  const { b, at } = walk();
  assert.equal(b.flushNow(at(MIN)).digest, null, 'nothing queued: nothing to say');
  b.offer(worker('thr_a', 'replied'), at(2 * MIN));
  b.offer(worker('thr_b', 'needs-input'), at(2 * MIN + 1000));
  const r = b.flushNow(at(2 * MIN + 5000));
  assert.ok(r.digest, 'delivered now, without waiting for the slot');
  assert.equal(r.digest.count, 2);
  assert.match(r.digest.body, /needs you/);
  assert.equal(b.flushNow(at(2 * MIN + 6000)).digest, null, 'already handed out');
  const night = walk({ timeZone: ZONE });
  night.b.offer(worker('thr_c', 'replied'), night.at(13 * 60 * MIN)); // 23:00 local: quiet hours
  assert.equal(night.b.flushNow(night.at(13 * 60 * MIN + 5000)).digest, null, 'quiet hours hold it');
});

test('the user\'s notes can be recalled by voice, from any earlier call, and only through the thought tool', async () => {
  const store = memory();
  await captureThought(store, { text: 'Offsite: ask Jordan about the venue date' }, { now: () => new Date(T0) });
  await captureThought(store, { text: 'Pricing page with the three month option first' }, { now: () => new Date(T0 + MIN) });
  await captureThought(store, { text: 'Buy dog food' }, { now: () => new Date(T0 + 2 * MIN) });
  let captured = 0;
  const requests = new UserRequests();
  const tool = createThoughtTool({ store, requests, sessionId: 'session_2', onCaptured: () => { captured++; } });
  const route = withThoughtTool(async name => { throw new Error(`fell through: ${name}`); }, tool);
  const recent = await route('bb_recall_thoughts', { query: null, since: null, limit: 2 });
  assert.deepEqual(recent.thoughts.map(t => t.text), ['Buy dog food', 'Pricing page with the three month option first']);
  assert.equal(recent.searched, 3);
  const found = await route('bb_recall_thoughts', { query: 'the pricing idea', since: null, limit: 5 });
  assert.equal(found.thoughts[0].text, 'Pricing page with the three month option first');
  const none = await route('bb_recall_thoughts', { query: 'zebra', since: null, limit: 5 });
  assert.equal(none.thoughts.length, 0); assert.equal(none.searched, 3);
  const later = await route('bb_recall_thoughts', { query: null, since: new Date(T0 + MIN).toISOString(), limit: 5 });
  assert.equal(later.thoughts.length, 2);
  requests.append('thought bubble, call the vet', T0, true);
  await route('bb_capture_thought', { text: 'Call the vet', request: 'thought bubble, call the vet' });
  assert.equal(captured, 1, 'the walk history is told to blank the turn');
  assert.ok(offered().includes('bb_recall_thoughts'));
});
