// @vitest-environment node
// Created: 2026-09-28. The notebook through the REAL /voice route and rpc in server.ts: a Walk call from the
// phone is recorded (spoken and typed turns, surface from the client), readable over the notebook rpc, and a
// note deleted over the thought rpc disappears from the list. GPT-Live is an in-memory socket.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeLive extends EventEmitter {
    readyState = 1; bufferedAmount = 0; sent: any[] = [];
    constructor(public url: string) { super(); live.sockets.push(this); queueMicrotask(() => this.emit('open')); }
    send(raw: string) {
      const event = JSON.parse(raw); this.sent.push(event);
      if (event.type === 'session.close') queueMicrotask(() => this.close());
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
    push(event: object) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  }
  return { default: FakeLive };
});

const dir = mkdtempSync(join(tmpdir(), 'ttbb-notebook-'));
const fakeBb = join(dir, 'fake-bb.mjs');
writeFileSync(fakeBb, `const [a, b, id] = process.argv.slice(2);
process.stdout.write(a === 'thread' && b === 'show' ? JSON.stringify({ thread: { id, title: 'Permit renewal: agency follow-up', projectId: 'proj_a', status: 'active' } })
  : b === 'list' ? '[]' : '{}');`);
const wait = async (check: () => unknown, ms = 6000) => {
  const until = Date.now() + ms;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > until) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 15)); }
};
const browser = (s: any) => s.sent.filter((m: any) => typeof m === 'string').map((m: string) => JSON.parse(m));

let host: any;
beforeEach(async () => {
  const { createFakePluginHost } = await import('@get-bb/plugin-sdk/testing');
  const { default: plugin } = await import('../server.ts');
  host = createFakePluginHost({ pluginId: 'talk-to-bb', settings: { apiKey: 'sk-test', cliPath: fakeBb, timeZone: 'UTC' } });
  await plugin(host.bb);
});
afterEach(async () => { await host?.harness.lifecycle.dispose(); live.sockets.length = 0; });
const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);

test('a Walk call is kept in the notebook with its spoken and typed turns, and read back over rpc', async () => {
  const phone = await host.harness.behavior.experimental_openWebSocket('/voice', { headers: { 'user-agent': 'Pocket/42 CFNetwork/1568 Darwin/25.0.0' } });
  await phone.receive(JSON.stringify({ type: 'start', context: { threadId: null, projectId: null } }));
  const provider = await wait(() => live.sockets[0]?.sent.find((e: any) => e.type === 'session.start') && live.sockets[0]);
  provider.push({ type: 'session.started' });
  await wait(() => browser(phone).some((e: any) => e.type === 'ready'));
  provider.push({ type: 'session.input_transcript.delta', delta: 'What changed ' });
  provider.push({ type: 'session.input_transcript.delta', delta: 'since this morning?' });
  provider.push({ type: 'session.output_transcript.delta', delta: 'Two agents replied.' });
  await phone.receive(JSON.stringify({ type: 'ask', text: 'Which one first?' }));
  await phone.receive(JSON.stringify({ type: 'stop' }));
  const listed: any = await wait(async () => { const r: any = await rpc('notebook', { op: 'list' }); return r.sessions[0]?.endedAt && r; });
  expect(listed.sessions).toHaveLength(1);
  expect(listed.sessions[0]).toMatchObject({ surface: 'walk', preview: 'What changed since this morning?', turnCount: 3 });
  const { session }: any = await rpc('notebook', { op: 'get', id: listed.sessions[0].id });
  expect(session.turns.map((t: any) => [t.speaker, t.text, Boolean(t.typed)])).toEqual([
    ['you', 'What changed since this morning?', false], ['bb', 'Two agents replied.', false], ['you', 'Which one first?', true]]);
  await expect(rpc('notebook', { op: 'get', id: '../thought:x' })).rejects.toThrow();
});

test('a note captured from the phone can be listed and deleted over the thought rpc; deleting twice is harmless', async () => {
  const saved: any = await rpc('thought', { op: 'capture', text: 'Shorter onboarding email', capturedVia: 'siri' });
  expect((await rpc('thought', { op: 'list' }) as any).thoughts).toHaveLength(1);
  expect(await rpc('thought', { op: 'delete', id: saved.thought.id })).toEqual({ id: saved.thought.id, deleted: true });
  expect((await rpc('thought', { op: 'list' }) as any).thoughts).toHaveLength(0);
  expect(await rpc('thought', { op: 'delete', id: saved.thought.id })).toEqual({ id: saved.thought.id, deleted: false });
});

// 2026-09-28: a Walk handed to a thread and back, then a dropped connection, is ONE notebook entry: the thread's
// words carry its title and id (panel and notebook), the line is an action, and the duration is the whole walk.
test('manager, a direct thread line, the manager again and a reconnect after a drop are one conversation', async () => {
  const pocket = { headers: { 'user-agent': 'Pocket/42 CFNetwork/1568 Darwin/25.0.0' } };
  const phone = await host.harness.behavior.experimental_openWebSocket('/voice', pocket);
  await phone.receive(JSON.stringify({ type: 'start', context: { threadId: null, projectId: null } }));
  const started = async (i: number) => { const s = await wait(() => live.sockets[i]?.sent.find((e: any) => e.type === 'session.start') && live.sockets[i]); s.push({ type: 'session.started' }); return s; };
  const manager = await started(0);
  await wait(() => browser(phone).some((e: any) => e.type === 'ready'));
  manager.push({ type: 'session.input_transcript.delta', delta: 'Put me through to the permit thread.' });
  manager.push({ type: 'session.output_transcript.delta', delta: 'Handing you over.' });
  await phone.receive(JSON.stringify({ type: 'worker-start', threadId: 'thr_permit' }));
  const worker = await started(1);
  await wait(() => browser(phone).some((e: any) => e.type === 'leg' && e.mode === 'worker'));
  worker.push({ type: 'session.output_transcript.delta', delta: 'You are on the permit thread.' });
  worker.push({ type: 'session.input_transcript.delta', delta: 'What is it waiting on?' });
  worker.push({ type: 'session.output_transcript.delta', delta: 'The agency reply.' });
  await new Promise(r => setTimeout(r, 1100)); // a line long enough that the last manager leg alone would undercount
  await phone.receive(JSON.stringify({ type: 'worker-return' }));
  const back = await started(2);
  back.push({ type: 'session.output_transcript.delta', delta: 'Back with the manager.' });
  // The panel hears the line's words under the thread's name, and no "last session" card mid-call.
  expect(browser(phone).filter((e: any) => e.type === 'transcript' && e.leg === 'worker' && e.speaker === 'assistant').map((e: any) => [e.title, e.threadId]))
    .toEqual([['Permit renewal: agency follow-up', 'thr_permit'], ['Permit renewal: agency follow-up', 'thr_permit']]);
  await new Promise(r => setTimeout(r, 200));
  expect(browser(phone).some((e: any) => e.type === 'resume' && !e.summary?.handoff)).toBe(false);

  // The connection drops; the next call continues the same walk and lands in the same entry.
  await phone.close(1006, 'network');
  await wait(async () => !(await rpc('status', null) as any).active);
  const again = await host.harness.behavior.experimental_openWebSocket('/voice', pocket);
  await again.receive(JSON.stringify({ type: 'start', context: { threadId: null, projectId: null } }));
  const last = await started(3);
  await wait(() => browser(again).some((e: any) => e.type === 'resume' && e.summary?.handoff));
  last.push({ type: 'session.output_transcript.delta', delta: 'Picking up where we were.' });
  await again.receive(JSON.stringify({ type: 'stop' }));

  const listed: any = await wait(async () => { const r: any = await rpc('notebook', { op: 'list' }); return r.sessions[0]?.endedAt && r.sessions[0].legs === 4 && r; });
  expect(listed.sessions).toHaveLength(1);
  const { session }: any = await rpc('notebook', { op: 'get', id: listed.sessions[0].id });
  expect(session.surface).toBe('walk');
  expect(session.turns.map((t: any) => [t.label, t.text])).toEqual([
    ['You', 'Put me through to the permit thread.'], ['BB', 'Handing you over.'],
    ['Permit renewal: agency follow-up', 'You are on the permit thread.'], ['You', 'What is it waiting on?'],
    ['Permit renewal: agency follow-up', 'The agency reply.'], ['BB', 'Back with the manager.'], ['BB', 'Picking up where we were.']]);
  expect(session.turns.filter((t: any) => t.speaker === 'thread').every((t: any) => t.threadId === 'thr_permit' && t.link === '@thread:thr_permit')).toBe(true);
  expect(session.legs).toBe(4);
  expect(session.seconds).toBeGreaterThanOrEqual(1);
  expect(Math.abs(session.seconds - (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000)).toBeLessThanOrEqual(1);
  expect(session.actions).toEqual([expect.objectContaining({ kind: 'worker-line', status: 'returned', threadId: 'thr_permit',
    title: 'Permit renewal: agency follow-up', link: '@thread:thr_permit' })]);
}, 20000);
