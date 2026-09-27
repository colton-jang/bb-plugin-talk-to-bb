// Created: 2026-09-15. The production worker-event dispatcher, as one testable module.
// server.ts registers this and nothing else, so a test drives the same code the host does
// rather than a hand-copied version of its condition.
import { recentReceipts } from './bb-manager.mjs';
import { correlateWorkerEvent } from './reliability.mjs';

export const WORKER_EVENTS = ['thread.idle', 'thread.failed', 'interaction.pending'];
const none = { updates: [], announcement: null, spoken: false };
const MAX_SETTLES = 20; // about four minutes of follow-on turns at the server's 12 s window

const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const inputText = (row) => (Array.isArray(row?.data?.input) ? row.data.input : [])
  .filter((part) => part?.type === 'text').map((part) => part.text).join(' ');

/**
 * Which turn answered a message, read from BB's own thread event log (B19). The message's
 * request is found by its text; the answer is the last turn in the chain that starts with the
 * turn that accepted it and continues through turns the provider starts on its own. New outside
 * input, or `settleMs` of quiet after a turn completes, ends the chain. A steer that lands as a
 * turn is ending is answered in such a follow-on turn, which has no request of its own.
 * @param {any[]} events @param {{marker:string,since:number,now:number,settleMs:number}} options
 * @returns {{kind:'unknown'|'pending'}|{kind:'answered',at:number,text:string|null,seq:any}}
 */
export function findAnswer(events, { marker, since, now, settleMs }) {
  const key = norm(marker).slice(0, 120);
  if (key.length < 10 || !Array.isArray(events)) return { kind: 'unknown' };
  const rows = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  const request = rows.find((row) => row.type === 'client/turn/requested' && Number(row.createdAt) >= since - 5000
    && norm(inputText(row)).includes(key));
  if (!request) return { kind: 'unknown' };
  const start = rows.findIndex((row) => row.type === 'turn/input/accepted'
    && row.data?.clientRequestId === request.data?.requestId && Number(row.seq) > Number(request.seq));
  if (start < 0) return { kind: 'pending' };
  let text = null, done = null;
  for (const row of rows.slice(start + 1)) {
    if (row.type === 'item/completed' && row.data?.item?.type === 'agentMessage' && typeof row.data.item.text === 'string') text = row.data.item.text;
    else if (row.type === 'turn/completed') done = { at: Number(row.createdAt), text, seq: row.seq };
    else if (row.type === 'client/turn/requested' && done) return { kind: 'answered', ...done };
    else if (row.type === 'turn/started' && done) { done = null; text = null; }
  }
  if (done && now - done.at >= settleMs - 1000) return { kind: 'answered', ...done };
  return { kind: 'pending' };
}

/**
 * Newest-first pages of a thread's event log back to `since`. The server caps a page at 100
 * rows, so a busy thread takes several.
 * @param {(beforeSeq?:string)=>Promise<any[]>} page @param {number} since
 */
export async function collectEvents(page, since, maxPages = 15) {
  const rows = []; let before;
  for (let i = 0; i < maxPages; i++) {
    const batch = await page(before);
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    const oldest = batch.reduce((a, b) => (Number(a.seq) < Number(b.seq) ? a : b));
    if (Number(oldest.createdAt) < since - 5000 || batch.length < 100) break;
    before = String(oldest.seq);
  }
  return rows;
}

/**
 * One BB thread event in, one receipt updated and at most one spoken announcement out.
 * `session` and `publish` are read at call time because a voice session comes and goes
 * while the plugin stays loaded.
 *
 * An idle that would become the answer to a request made in the live call is settled first
 * (B19): the event log decides which turn answered it (`findAnswer`), and the answer's text
 * comes from that turn, not from whichever idle fired. Without a usable log, the fallback is a
 * status check: still idle with nothing queued. Settling runs after the handler returns
 * (`settling`), so BB's event dispatch never waits on it.
 * @param {{store:any,session:()=>any,publish?:(receipt:any)=>void,now?:()=>number,
 *   readThread?:((id:string)=>any)|null,listEvents?:((id:string,since:number)=>any)|null,settleMs?:number,
 *   lookupTimeoutMs?:number,wait?:(ms:number)=>Promise<void>}} deps
 */
export function createWorkerEventHandler({ store, session, publish = () => {}, now = Date.now,
  readThread = null, listEvents = null, settleMs = 0, lookupTimeoutMs = 8000,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const latest = new Map(); let sequence = 0, disposed = false;
  // Receipt writes are read-modify-write; one at a time so a late settle cannot lose an update.
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const guarded = (fn) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lookup timed out')), lookupTimeoutMs);
    Promise.resolve().then(fn).then((value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
  async function apply(event, data, at) {
    const { updates, announcement } = correlateWorkerEvent({
      receipts: await recentReceipts(store), event, thread: data.thread,
      lastAssistantText: data.lastAssistantText ?? null, at,
    });
    for (const next of updates) { await store.set(next.key, next); publish(next); }
    // Delivery policy lives in the session: review first, then quiet. There is no second path.
    const live = session();
    // A reply to something asked in this very call is an answer the user is waiting for.
    if (announcement) announcement.askedThisCall = Boolean(live?.sessionId && updates[0]?.sessionId === live.sessionId);
    const spoken = Boolean(announcement && live && !live.closing && live.notifyWorker(announcement));
    return { updates, announcement, spoken };
  }
  async function settle(event, data, at, token, receipt) {
    const threadId = data.thread.id;
    const current = () => !disposed && latest.get(threadId) === token;
    for (let attempt = 0; attempt < MAX_SETTLES; attempt++) {
      await wait(settleMs);
      if (!current()) return { ...none, superseded: true };
      const rows = listEvents ? await guarded(() => listEvents(threadId, Date.parse(receipt.at))).catch(() => null) : null;
      const found = rows ? findAnswer(rows, { marker: receipt.summary, since: Date.parse(receipt.at), now: now(), settleMs }) : { kind: 'unknown' };
      if (found.kind === 'pending') continue; // a follow-on turn is running, or ours has not started
      latest.delete(threadId);
      if (found.kind === 'answered')
        return serial(() => apply(event, { ...data, lastAssistantText: found.text ?? data.lastAssistantText ?? null }, Math.max(at, found.at || 0)));
      // No usable log: the thread must still be idle with nothing queued. Unreadable: apply as it came.
      const state = readThread ? await guarded(() => readThread(threadId)).catch(() => null) : null;
      if (state && (state.status !== 'idle' || Number(state.queuedMessageCount) > 0)) return { ...none, unsettled: true };
      return serial(() => apply(event, data, at));
    }
    if (current()) latest.delete(threadId);
    return { ...none, unsettled: true };
  }
  async function handleWorkerEvent(event, data) {
    if (disposed || !WORKER_EVENTS.includes(event) || !data?.thread?.id) return none;
    const at = now();
    if (event !== 'thread.idle' || !(settleMs > 0) || (!readThread && !listEvents)) return serial(() => apply(event, data, at));
    // Only an answer to a request made in the live call is read back, so only that is settled;
    // everything else (tracking updates, earlier calls' receipts, no call at all) applies at once.
    const proposed = correlateWorkerEvent({ receipts: await recentReceipts(store), event, thread: data.thread,
      lastAssistantText: data.lastAssistantText ?? null, at });
    const live = session();
    const receipt = proposed.updates[0];
    if (!proposed.announcement || !live?.sessionId || receipt?.sessionId !== live.sessionId) return serial(() => apply(event, data, at));
    const token = ++sequence;
    latest.set(data.thread.id, token); // a newer idle for this thread takes over the settle
    const settling = settle(event, data, at, token, receipt).catch(() => none);
    return { ...none, settling };
  }
  /** Stop pending settles when the plugin is reloaded or unloaded. */
  handleWorkerEvent.dispose = () => { disposed = true; latest.clear(); };
  return handleWorkerEvent;
}
