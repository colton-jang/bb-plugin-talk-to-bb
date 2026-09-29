// @vitest-environment node
// Created: 2026-09-27. Network-switch recovery through the REAL /voice route in server.ts.
// Field bug: moving from Wi-Fi to 5G mid-walk ended the call, and starting again said "a
// session is already open". These tests drive the half-open socket, the clean drop, the
// orphan watchdog and the reconnect races deterministically. GPT-Live is an in-memory socket.
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

const dir = mkdtempSync(join(tmpdir(), 'ttbb-netdrop-'));
const fakeBb = join(dir, 'fake-bb.mjs');
writeFileSync(fakeBb, `process.stdout.write(process.argv[3]==='list'?'[]':'{}');`);

const wait = async (check: () => unknown, ms = 6000) => {
  const until = Date.now() + ms;
  for (;;) { const v = check(); if (v) return v; if (Date.now() > until) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 15)); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const browser = (s: any) => s.sent.filter((m: any) => typeof m === 'string').map((m: string) => JSON.parse(m));
const START = JSON.stringify({ type: 'start', context: { threadId: null, projectId: null } });

let host: any, TIMING: any, saved: any;
beforeEach(async () => {
  ({ TIMING } = await import('../netdrop.mjs'));
  saved = { ...TIMING };
  Object.assign(TIMING, { takeoverStaleMs: 150, deadClientMs: 400, evictTimeoutMs: 500, watchdogIntervalMs: 40 });
  const { createFakePluginHost } = await import('@get-bb/plugin-sdk/testing');
  const { default: plugin } = await import('../server.ts');
  host = createFakePluginHost({ pluginId: 'talk-to-bb', settings: { apiKey: 'sk-test', cliPath: fakeBb, timeZone: 'UTC' } });
  await plugin(host.bb);
});
afterEach(async () => { Object.assign(TIMING, saved); await host?.harness.lifecycle.dispose(); live.sockets.length = 0; });

const status = async () => (await host.harness.behavior.callRpc('status', null)).active;
async function call(index: number) {
  const phone = await host.harness.behavior.experimental_openWebSocket('/voice');
  await phone.receive(START);
  const provider = await wait(() => live.sockets[index]?.sent.find((e: any) => e.type === 'session.start') && live.sockets[index]);
  provider.push({ type: 'session.started' });
  await wait(() => browser(phone).some((e: any) => e.type === 'ready'));
  return { phone, provider };
}
const said = (phone: any, words: string) => phone.receive(JSON.stringify({ type: 'ask', text: words }));

test('Wi-Fi -> 5G: a silent (half-open) call is taken over, not refused, and the walk continues', async () => {
  const first = await call(0);
  await said(first.phone, 'we were talking about the Ascend budget');
  await first.phone.receive(new Uint8Array(640));
  // The old socket never closes (half-open); it just goes quiet past the takeover window.
  await sleep(250);
  const second = await host.harness.behavior.experimental_openWebSocket('/voice');
  await second.receive(START);
  const provider2 = await wait(() => live.sockets[1]?.sent.find((e: any) => e.type === 'session.start') && live.sockets[1]);
  expect(browser(second).some((e: any) => e.type === 'fault')).toBe(false);
  expect(first.provider.sent.some((e: any) => e.type === 'session.close')).toBe(true);
  expect(first.provider.readyState).toBe(3);
  provider2.push({ type: 'session.started' });
  const resume = await wait(() => browser(second).find((e: any) => e.type === 'resume'));
  expect(resume.summary.handoff).toBe(true);
  const briefing = provider2.sent.find((e: any) => e.type === 'session.thinking.append' && /CONTINUES the user's current walk/.test(e.content));
  expect(briefing.content).toMatch(/Ascend budget/);
  expect(briefing.content.length).toBeLessThanOrEqual(1800);
  expect(await status()).toBe(true);
  expect(live.sockets.filter(s => s.readyState === 1)).toHaveLength(1);
});

test('a genuinely live call elsewhere is not taken over', async () => {
  const first = await call(0);
  await first.phone.receive(new Uint8Array(640));
  const other = await host.harness.behavior.experimental_openWebSocket('/voice');
  await other.receive(START);
  const fault = await wait(() => browser(other).find((e: any) => e.type === 'fault'));
  expect(fault.message).toMatch(/already live in another tab or device/);
  expect(first.provider.readyState).toBe(1);
  expect(live.sockets).toHaveLength(1);
});

test('a dropped socket (closed without End) frees the lock at once and the next call continues the walk', async () => {
  const first = await call(0);
  await said(first.phone, 'remind me about the invoice');
  await first.phone.close(1006, 'network');
  await wait(async () => !(await status()));
  expect(await status()).toBe(false);
  const second = await call(1);
  const resume = await wait(() => browser(second.phone).find((e: any) => e.type === 'resume'));
  expect(resume.summary.handoff).toBe(true);
});

test('End is an ending: the next call starts fresh, with no continuation', async () => {
  const first = await call(0);
  await first.phone.receive(JSON.stringify({ type: 'stop' }));
  await wait(async () => !(await status()));
  const second = await call(1);
  await sleep(100);
  expect(browser(second.phone).some((e: any) => e.type === 'resume' && e.summary?.handoff)).toBe(false);
});

test('an orphaned call is ended by the watchdog so it stops billing, even if nobody reconnects', async () => {
  const first = await call(0);
  await first.phone.receive(new Uint8Array(640));
  await wait(() => first.provider.readyState === 3, 3000);
  await wait(async () => !(await status()));
  expect(first.provider.sent.some((e: any) => e.type === 'session.close')).toBe(true);
});

test('pings keep a quiet call alive', async () => {
  const first = await call(0);
  for (let i = 0; i < 8; i++) { await sleep(100); await first.phone.receive(JSON.stringify({ type: 'ping' })); }
  expect(first.provider.readyState).toBe(1);
  expect(browser(first.phone).some((e: any) => e.type === 'pong')).toBe(true);
  expect(await status()).toBe(true);
});

test('two reconnects racing after a drop produce exactly one call', async () => {
  const first = await call(0);
  await sleep(250);
  const a = await host.harness.behavior.experimental_openWebSocket('/voice');
  const b = await host.harness.behavior.experimental_openWebSocket('/voice');
  await Promise.all([a.receive(START), b.receive(START)]);
  await sleep(300);
  const starts = live.sockets.filter(s => s !== first.provider && s.sent.some((e: any) => e.type === 'session.start'));
  expect(starts).toHaveLength(1);
  const faults = [a, b].filter(s => browser(s).some((e: any) => e.type === 'fault'));
  expect(faults).toHaveLength(1);
  expect(first.provider.readyState).toBe(3);
});
