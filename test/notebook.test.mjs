// Created: 2026-09-28. The notebook (every voice conversation, kept for the computer) and deleting notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebook, surfaceOf, notebookInput, NOTE_DELETED } from '../notebook.mjs';
import { captureThought, findThoughtById, listThoughts, thoughtInput, thoughtRpc, createThoughtTool, withThoughtTool,
  thoughtDefinitions } from '../ambient.mjs';
import { UserRequests, recentReceipts } from '../bb-manager.mjs';
import { backendInstructions, config } from '../live-session.mjs';

function memory() {
  const map = new Map();
  return { map,
    get: async key => map.has(key) ? structuredClone(map.get(key)) : undefined,
    set: async (key, value) => { map.set(key, structuredClone(value)); },
    delete: async key => { map.delete(key); },
    list: async prefix => [...map.keys()].filter(k => k.startsWith(prefix ?? '')),
  };
}
const T0 = Date.parse('2026-09-28T18:00:00Z');
const MIN = 60000, DAY = 86400000;
const sid = (ms, n = 1) => `${ms}-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const POCKET_UA = 'Pocket/42 CFNetwork/1568 Darwin/25.0.0';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';

test('the surface comes from the start context, then the client: Hey BB, check-in, Walk, panel', () => {
  assert.equal(surfaceOf({ source: 'hey-bb', ambientRun: 'run_abcdefgh' }, { userAgent: POCKET_UA }), 'hey-bb');
  assert.equal(surfaceOf({ source: 'checkin', ambientId: 'amb_abcdefgh' }, { userAgent: POCKET_UA }), 'check-in');
  assert.equal(surfaceOf({ ambientId: 'amb_abcdefgh' }, { userAgent: POCKET_UA }), 'check-in', 'a call opened from a check-in the user said yes to');
  assert.equal(surfaceOf({ threadId: null, projectId: null }, { userAgent: POCKET_UA }), 'walk');
  assert.equal(surfaceOf({ threadId: null, projectId: null }, { userAgent: BROWSER_UA }), 'panel');
  assert.equal(surfaceOf({}, {}), 'panel');
});

test('a call is recorded as turns, typed questions, actions and notes, and read back newest first', async () => {
  const store = memory(); let now = T0;
  const book = createNotebook({ store, now: () => now });
  const rec = await book.open({ id: sid(T0), surface: 'walk', context: { threadId: null } });
  for (const text of ['What needs ', 'me today?']) rec.transcript({ speaker: 'you', text });
  now += 2000;
  for (const text of ['Two threads ', 'replied.']) rec.transcript({ speaker: 'assistant', text });
  rec.typed('Open the release thread');
  rec.transcript({ speaker: 'assistant', text: 'Here it is from the thread.' }, { worker: true });
  rec.transcript({ speaker: 'you', text: 'thought bubble, a shorter onboarding email' });
  rec.note({ id: 'tht_aaaaaaaaaaaaaaaa' });
  const receipt = { key: `action:${sid(T0)}:d1`, id: 'r1', kind: 'bb_spawn_thread', status: 'dispatching', title: 'Draft the release notes', threadId: 'thr_worker1', model: 'claude-opus-5-5', at: new Date(T0).toISOString() };
  rec.action(receipt);
  rec.action({ ...receipt, status: 'started' });
  await store.set(receipt.key, { ...receipt, status: 'started', workerState: 'replied' }); // a worker event after the call
  now += 5 * MIN;
  await rec.close({ reason: 'ended', seconds: 290 });

  const { session } = await book.get(sid(T0), { findNote: async id => ({ id, text: 'A shorter onboarding email', capturedVia: 'voice' }) });
  assert.deepEqual(session.turns.map(t => [t.speaker, t.text]), [
    ['you', 'What needs me today?'], ['bb', 'Two threads replied.'], ['you', 'Open the release thread'],
    ['thread', 'Here it is from the thread.'], ['you', 'thought bubble, a shorter onboarding email']]);
  assert.equal(session.turns[2].typed, true);
  assert.equal(session.turns[4].noteId, 'tht_aaaaaaaaaaaaaaaa');
  assert.equal(session.actions.length, 1, 'one action, latest state');
  assert.deepEqual({ status: session.actions[0].status, workerState: session.actions[0].workerState, link: session.actions[0].link },
    { status: 'started', workerState: 'replied', link: '@thread:thr_worker1' });
  assert.equal(session.notes[0].text, 'A shorter onboarding email');
  assert.equal(session.surface, 'walk'); assert.equal(session.endedAt, new Date(T0 + 2000 + 5 * MIN).toISOString());

  const second = await book.open({ id: sid(T0 + DAY / 2, 2), surface: 'panel' });
  second.transcript({ speaker: 'you', text: 'Later question' });
  await second.close({});
  const { sessions } = await book.list();
  assert.deepEqual(sessions.map(s => s.id), [sid(T0 + DAY / 2, 2), sid(T0)], 'newest first');
  assert.equal(sessions[1].preview, 'What needs me today?');
  assert.deepEqual([sessions[1].turnCount, sessions[1].actionCount, sessions[1].noteCount], [5, 1, 1]);
  assert.equal(notebookInput.safeParse({ op: 'get', id: 'notebook:../x' }).success, false);
  assert.equal((await book.get('bogus')).session, null);
});

test('a continued walk (limit handoff or network drop) stays one conversation, timed first start to last end', async () => {
  const store = memory(); let now = T0;
  const book = createNotebook({ store, now: () => now });
  const first = await book.open({ id: sid(T0), surface: 'walk' });
  first.leg();
  first.transcript({ speaker: 'you', text: 'part one' });
  now += 20 * MIN;
  await first.close({ reason: 'handoff', seconds: 1200 });
  now += 5000; // the reconnect gap is part of the walk
  const next = await book.open({ id: sid(T0), surface: 'walk', continued: true });
  next.leg();
  next.transcript({ speaker: 'you', text: 'part two' });
  now += MIN;
  await next.close({ reason: 'ended', seconds: 60 });
  const { session } = await book.get(sid(T0));
  assert.deepEqual(session.turns.map(t => t.text), ['part one', 'part two']);
  assert.equal(session.legs, 2); assert.equal(session.seconds, 20 * 60 + 5 + 60);
  assert.equal(session.endedAt, new Date(now).toISOString());
  assert.equal((await book.list()).sessions.length, 1);
});

test('a walk handed to a thread and back is one conversation: the thread speaks under its title, the line is an action', async () => {
  const store = memory(); let now = T0;
  const book = createNotebook({ store, now: () => now });
  const hce = { threadId: 'thr_hce1', title: 'State agency: permit renewal' };
  const rec = await book.open({ id: sid(T0), surface: 'walk' });
  rec.leg(); // the manager
  rec.transcript({ speaker: 'you', text: 'Put me through to the permit thread.' });
  rec.transcript({ speaker: 'assistant', text: 'Handing you over.' });
  now += 10000;
  rec.leg(); rec.workerLine({ state: 'opened', target: hce }); // the direct line
  for (const text of ['You are on ', 'the permit thread.']) rec.transcript({ speaker: 'assistant', text }, { thread: hce });
  rec.transcript({ speaker: 'you', text: 'What is it waiting on?' });
  rec.transcript({ speaker: 'assistant', text: 'The agency reply.' }, { thread: hce });
  now += 90000;
  rec.workerLine({ state: 'returned', target: hce });
  rec.leg(); // the manager again, a new session
  rec.transcript({ speaker: 'assistant', text: 'Back with the manager.' });
  now += 66000;
  await rec.close({ reason: 'ended', seconds: 40 }); // the last manager session's own seconds do not decide the duration

  const { session } = await book.get(sid(T0));
  assert.deepEqual(session.turns.map(t => [t.speaker, t.label, t.text]), [
    ['you', 'You', 'Put me through to the permit thread.'], ['bb', 'BB', 'Handing you over.'],
    ['thread', hce.title, 'You are on the permit thread.'], ['you', 'You', 'What is it waiting on?'],
    ['thread', hce.title, 'The agency reply.'], ['bb', 'BB', 'Back with the manager.']]);
  assert.deepEqual(session.turns.filter(t => t.speaker === 'thread').map(t => [t.threadId, t.link]),
    [['thr_hce1', '@thread:thr_hce1'], ['thr_hce1', '@thread:thr_hce1']]);
  assert.equal(session.turns[0].threadId, undefined, 'only a thread turn names a thread');
  assert.equal(session.seconds, 166); assert.equal(session.legs, 3);
  assert.deepEqual(session.actions.map(a => [a.kind, a.status, a.title, a.link, a.endedAt]),
    [['worker-line', 'returned', hce.title, '@thread:thr_hce1', new Date(T0 + 100000).toISOString()]]);
  const [row] = (await book.list()).sessions;
  assert.deepEqual([row.seconds, row.legs, row.turnCount, row.actionCount], [166, 3, 6, 1]);
});

test('two threads back to back never merge; a line still open when the call ends reads as ended; old entries still label', async () => {
  const store = memory();
  const book = createNotebook({ store, now: () => T0 });
  const a = { threadId: 'thr_aaa', title: 'Thread A' }, b = { threadId: 'thr_bbb', title: 'Thread B' };
  const rec = await book.open({ id: sid(T0), surface: 'panel' });
  rec.leg(); rec.workerLine({ state: 'opened', target: a });
  rec.transcript({ speaker: 'assistant', text: 'From A.' }, { thread: a });
  rec.workerLine({ state: 'returned', target: a });
  rec.leg(); rec.workerLine({ state: 'opened', target: b });
  rec.transcript({ speaker: 'assistant', text: 'From B.' }, { thread: b });
  rec.workerLine({ state: 'opened', target: { threadId: '../x', title: 'bad' } });
  await rec.close({ reason: 'ended' });
  const { session } = await book.get(sid(T0));
  assert.deepEqual(session.turns.map(t => [t.label, t.text]), [['Thread A', 'From A.'], ['Thread B', 'From B.']]);
  assert.deepEqual(session.actions.map(x => [x.id, x.title, x.status]), [['line-1', 'Thread A', 'returned'], ['line-2', 'Thread B', 'ended']]);
  // An entry recorded before speakers were named still reads: a thread turn is "Thread", the manager "BB".
  await store.set(`notebook:${sid(T0 + 1, 2)}`, { id: sid(T0 + 1, 2), surface: 'walk', startedAt: new Date(T0).toISOString(), endedAt: null,
    seconds: 40, legs: 1, turns: [{ speaker: 'bb', text: 'hi', at: '' }, { speaker: 'thread', text: 'from the thread', at: '' }], actions: [], notes: [] });
  assert.deepEqual((await book.get(sid(T0 + 1, 2))).session.turns.map(t => t.label), ['BB', 'Thread']);
});

test('retention: at most 200 conversations and none older than 30 days; a long call is capped, not lost', async () => {
  const store = memory(); let now = T0;
  const book = createNotebook({ store, now: () => now, limits: { maxSessions: 3 } });
  for (let i = 0; i < 5; i++) { const r = await book.open({ id: sid(T0 + i * MIN, i), surface: 'panel' }); await r.close({}); }
  await book.open({ id: sid(T0 + 10 * MIN, 9), surface: 'panel' });
  assert.equal((await store.list('notebook:')).length, 3, 'the oldest go first');
  now = T0 + 31 * DAY;
  assert.equal((await book.list()).sessions.length, 0, 'older than 30 days is not listed');
  const r = await book.open({ id: sid(now, 1), surface: 'panel' });
  assert.deepEqual(await store.list('notebook:'), [`notebook:${sid(now, 1)}`], 'and is deleted at the next call');
  const capped = createNotebook({ store, now: () => now, limits: { maxTextBytes: 40 } });
  const long = await capped.open({ id: sid(now + 1, 2), surface: 'panel' });
  for (let i = 0; i < 10; i++) long.transcript({ speaker: i % 2 ? 'assistant' : 'you', text: 'twelve bytes' });
  long.action({ id: 'r9', kind: 'bb_tell_thread', status: 'sent', title: 'Still recorded', threadId: 'thr_x' });
  await long.close({});
  const { session } = await capped.get(sid(now + 1, 2));
  assert.equal(session.truncated, true); assert.equal(session.turns.length, 3); assert.equal(session.actions.length, 1);
  await r.close({});
});

test('deleting a note removes it, its Siri retry index and its words in the notebook; deleting again is harmless', async () => {
  const store = memory(); const now = () => new Date(T0);
  const saved = await thoughtRpc(store, thoughtInput.parse({ op: 'capture', text: 'Rename the settings page', capturedVia: 'siri', clientId: 'client-12345678' }), { now });
  const kept = await captureThought(store, { text: 'Keep this one' }, { now: () => new Date(T0 + 1000) });
  const book = createNotebook({ store, now: () => T0 });
  const stored = await book.open({ id: sid(T0), surface: 'walk' });
  stored.transcript({ speaker: 'you', text: 'write this down, rename the settings page' }); stored.note(saved.thought);
  stored.transcript({ speaker: 'assistant', text: 'Got it.' });
  await stored.close({});
  const liveCall = await book.open({ id: sid(T0 + MIN, 2), surface: 'panel' });
  liveCall.transcript({ speaker: 'you', text: 'note: rename the settings page' }); liveCall.note(saved.thought);

  assert.equal(thoughtInput.safeParse({ op: 'delete', id: 'thought:x' }).success, false);
  const result = await thoughtRpc(store, thoughtInput.parse({ op: 'delete', id: saved.thought.id }));
  assert.deepEqual(result, { id: saved.thought.id, deleted: true });
  assert.equal(await findThoughtById(store, saved.thought.id), null);
  assert.deepEqual((await listThoughts(store)).map(t => t.id), [kept.thought.id]);
  assert.deepEqual(await store.list('thought-client:'), [], 'a retry index pointing at it is gone too');
  const { session } = await book.get(sid(T0));
  assert.deepEqual(session.turns.map(t => t.text), [NOTE_DELETED, 'Got it.']);
  assert.deepEqual(session.notes, []);
  await liveCall.close({});
  assert.doesNotMatch(JSON.stringify((await book.get(sid(T0 + MIN, 2))).session), /settings page/, 'a call still live when it was deleted cannot write it back');
  assert.deepEqual(await thoughtRpc(store, { op: 'delete', id: saved.thought.id }), { id: saved.thought.id, deleted: false });
});

test('voice delete: found first, named back, confirmed by the user\'s own words after that; nothing else is deleted', async () => {
  const store = memory();
  const a = await captureThought(store, { text: 'Try a weekly digest email' }, { now: () => new Date(T0) });
  const b = await captureThought(store, { text: 'Buy printer paper' }, { now: () => new Date(T0 + MIN) });
  const requests = new UserRequests();
  const deleted = [];
  const tool = createThoughtTool({ store, requests, sessionId: 'session_9', onDeleted: id => deleted.push(id) });
  const route = withThoughtTool(async name => { throw new Error(`fell through: ${name}`); }, tool);

  await assert.rejects(route('bb_forget_thought', { id: a.thought.id, request: 'delete it' }), /bb_recall_thoughts first/);
  requests.append('delete my note about the weekly digest', T0, true);
  const found = await route('bb_recall_thoughts', { query: 'weekly digest', since: null, limit: 5 });
  assert.equal(found.thoughts[0].id, a.thought.id);
  await assert.rejects(route('bb_forget_thought', { id: a.thought.id, request: 'delete my note about the weekly digest' }),
    /wait for them to confirm|wait: their confirmation/, 'the ask that came before the note was named is not the confirmation');
  requests.append('yes that one', T0 + 5000, true);
  await assert.rejects(route('bb_forget_thought', { id: b.thought.id, request: 'yes that one' }), /bb_recall_thoughts first/, 'a note never named cannot be deleted');
  await assert.rejects(route('bb_forget_thought', { id: a.thought.id, request: 'words from some thread' }), /not in this live conversation/);
  const done = await route('bb_forget_thought', { id: a.thought.id, request: 'yes that one' });
  assert.equal(done.deleted, true); assert.match(done.note, /Deleted/);
  assert.deepEqual(deleted, [a.thought.id]);
  assert.deepEqual((await listThoughts(store)).map(t => t.text), ['Buy printer paper']);
  assert.equal((await recentReceipts(store)).length, 0, 'a delete is not an action receipt either');
  await assert.rejects(route('bb_forget_thought', { id: a.thought.id, request: 'yes that one' }), /bb_recall_thoughts first/, 'one delete per recall');
});

test('the backend is offered the delete tool and told in one line how notes are deleted', () => {
  assert.ok(config({}).delegation.responses.tools[0].parameters.properties.name.enum.includes('bb_forget_thought'));
  const forget = thoughtDefinitions.find(t => t.name === 'bb_forget_thought');
  assert.deepEqual(forget.parameters.required.sort(), ['id', 'request']);
  assert.match(forget.description, /bb_recall_thoughts/); assert.match(forget.description, /confirm/);
  assert.match(backendInstructions({}), /bb_forget_thought only after they confirm/);
});
