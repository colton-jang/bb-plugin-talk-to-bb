// @vitest-environment node
// Created: 2026-09-27. Direct-worker voice mode through the REAL /voice route in server.ts:
// the switch keeps one reservation and one browser socket, the worker leg is a new cedar
// session bound to one thread, and the manager comes back through the normal start path.
// GPT-Live is replaced by an in-memory socket; the BB CLI by a tiny script. No network.
import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

const dir = mkdtempSync(join(tmpdir(), 'ttbb-legs-'));
const cliLog = join(dir, 'calls.jsonl');
const fakeBb = join(dir, 'fake-bb.mjs');
writeFileSync(fakeBb, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify(args) + '\\n');
const out = v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
if (args[0] === 'thread' && args[1] === 'show') out({ thread: { id: args[2], title: 'pocket-ios: build milestone 1', projectId: 'proj_a', status: 'active' } });
else if (args[0] === 'thread' && args[1] === 'log') out('user: build it\\nassistant: building');
else if (args[0] === 'thread' && args[1] === 'tell') out({ delivery: 'sent' });
else if (args[0] === 'thread' && (args[1] === 'list' || args[1] === 'interactions' || args[1] === 'queue')) out([]);
else out({});
`);

const wait = async (check: () => unknown, ms = 8000) => {
  const until = Date.now() + ms;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > until) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 20)); }
};
const envelope = (event: object) => ({ type: 'response.event', delegation_id: 'del_1', event });
function callTool(socket: any, name: string, args: object, id = `call_${name}`) {
  socket.push(envelope({ type: 'response.created', response: { id: `r_${id}` } }));
  socket.push(envelope({ type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } }));
  socket.push(envelope({ type: 'response.completed', response: { id: `r_${id}`, output: [] } }));
}
const output = (socket: any, id: string) => {
  const item = socket.sent.find((e: any) => e.type === 'response.item.create' && e.item?.call_id === id);
  return item ? JSON.parse(item.item.output) : null;
};
const browser = (session: any) => session.sent.filter((m: any) => typeof m === 'string').map((m: string) => JSON.parse(m));
const cliCalls = () => existsSync(cliLog) ? readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

let host: any;
afterEach(async () => { await host?.harness.lifecycle.dispose(); live.sockets.length = 0; });

test('spoken switch to a cedar worker leg, scoped tell, panel return to a marin manager, one reservation throughout', async () => {
  const { createFakePluginHost } = await import('@get-bb/plugin-sdk/testing');
  const { default: plugin } = await import('../server.ts');
  host = createFakePluginHost({ pluginId: 'talk-to-bb', settings: { apiKey: 'sk-test', cliPath: fakeBb, timeZone: 'UTC' } });
  await plugin(host.bb);
  const status = async () => (await host.harness.behavior.callRpc('status', null)).active;

  const phone = await host.harness.behavior.experimental_openWebSocket('/voice');
  await phone.receive(JSON.stringify({ type: 'start', context: { threadId: null, projectId: null } }));
  const manager = await wait(() => live.sockets[0]?.sent.find((e: any) => e.type === 'session.start') && live.sockets[0]);
  expect(manager.sent[0].session.audio.output.voice).toBe('marin');
  // Colton's fork: the manager backend gets one compact bb_call tool naming its operations.
  expect(manager.sent[0].session.delegation.responses.tools[0].parameters.properties.name.enum).toContain('bb_talk_to_worker');
  manager.push({ type: 'session.started' });
  await wait(() => browser(phone).some((e: any) => e.type === 'ready'));
  expect(await status()).toBe(true);

  // The user asks, by voice, to talk to the thread directly; the backend resolves it.
  manager.push({ type: 'session.input_transcript.delta', delta: 'Let me talk directly to the Pocket thread and tell it the checklist comes first' });
  callTool(manager, 'bb_call', { name: 'bb_talk_to_worker', args: JSON.stringify({ threadId: 'thr_pocket', request: 'talk directly to the Pocket thread' }) }, 'switch');
  const switched = await wait(() => output(manager, 'switch'));
  expect(switched.switching).toBe(true);
  expect(browser(phone)).toContainEqual(expect.objectContaining({ type: 'leg', mode: 'switching', to: 'worker' }));

  // A second browser cannot start a call while this socket holds the line.
  const other = await host.harness.behavior.experimental_openWebSocket('/voice');
  await other.receive(JSON.stringify({ type: 'start', context: { threadId: null, projectId: null } }));
  expect(browser(other)).toContainEqual(expect.objectContaining({ type: 'fault' }));

  // After the handover delay the manager leg closes and a NEW cedar session opens.
  const worker = await wait(() => live.sockets[1]?.sent.find((e: any) => e.type === 'session.start') && live.sockets[1]);
  expect(manager.readyState).toBe(3);
  expect(browser(phone).some((e: any) => e.type === 'closed')).toBe(false);
  expect(await status()).toBe(true);
  const start = worker.sent[0].session;
  expect(start.audio.output.voice).toBe('cedar');
  expect(start.delegation.responses.tools.map((t: any) => t.name).sort()).toEqual(['bb_read_thread', 'bb_recent_actions', 'bb_return_to_manager', 'bb_tell_thread']);
  expect(start.delegation.responses.instructions).toContain('thr_pocket');
  worker.push({ type: 'session.started' });
  await wait(() => browser(phone).some((e: any) => e.type === 'leg' && e.mode === 'worker'));
  const appends = worker.sent.filter((e: any) => /append$/.test(e.type));
  expect(appends.map((e: any) => e.type)).toEqual(['session.thinking.append', 'session.commentary.append']);
  for (const a of appends) expect(a.content.length).toBeLessThanOrEqual(1800);

  // Mic audio now reaches the worker leg only.
  await phone.receive(new Uint8Array(640));
  expect(worker.sent.some((e: any) => e.type === 'session.input_audio.append')).toBe(true);
  expect(manager.sent.some((e: any) => e.type === 'session.input_audio.append')).toBe(false);

  // Scoped read, and a tell authorized by the switching sentence, land on the bound thread only.
  callTool(worker, 'bb_read_thread', { turns: 2 }, 'read');
  const read = await wait(() => output(worker, 'read'));
  expect(read.thread.id).toBe('thr_pocket');
  callTool(worker, 'bb_tell_thread', { message: 'The checklist comes first, then the README.', mode: 'queue', request: 'tell it the checklist comes first' }, 'tell');
  const told = await wait(() => output(worker, 'tell'));
  expect(told.receipt.status).toBe('sent');
  expect(cliCalls().filter(c => c[1] === 'tell').map(c => c[2])).toEqual(['thr_pocket']);
  callTool(worker, 'bb_spawn_thread', { projectId: 'proj_a' }, 'spawn');
  expect((await wait(() => output(worker, 'spawn'))).error).toMatch(/not available on a direct thread line/);

  // Panel "Back to manager": the worker closes and a new marin manager starts on the same socket.
  await phone.receive(JSON.stringify({ type: 'worker-return' }));
  const back = await wait(() => live.sockets[2]?.sent.find((e: any) => e.type === 'session.start') && live.sockets[2]);
  expect(worker.readyState).toBe(3);
  expect(back.sent[0].session.audio.output.voice).toBe('marin');
  expect(await status()).toBe(true);
  back.push({ type: 'session.started' });
  const handoff = await wait(() => back.sent.find((e: any) => e.type === 'session.thinking.append' && /back with you, the BB manager/.test(e.content)));
  expect(handoff.content.length).toBeLessThanOrEqual(1800);
  expect(handoff.content).toMatch(/sent: "The checklist comes first/);
  expect(browser(phone)).toContainEqual(expect.objectContaining({ type: 'leg', mode: 'manager', from: 'worker' }));

  // End releases everything as before.
  await phone.receive(JSON.stringify({ type: 'stop' }));
  await wait(() => browser(phone).some((e: any) => e.type === 'closed'));
  expect(await status()).toBe(false);
}, 20000);
