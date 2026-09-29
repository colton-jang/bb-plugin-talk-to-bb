// Created: 2026-09-27. Ambient Walk: batched spoken digests while the user's own music or podcast plays,
// plus "thought bubble" capture. Server-side brain only. It opens no audio, holds no mic and speaks nothing
// itself: a caller (Pocket's server-side notifier, or a live call) asks what is due and acknowledges what it
// actually delivered. Nothing here runs until an Ambient Walk is started, except thought capture.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeRequest, ActionError } from './bb-manager.mjs';
import { scrubNote } from './notebook.mjs';

export const AMBIENT_DEFAULTS = Object.freeze({
  intervalMs: 2 * 60000,       // at most one digest every 2 minutes; nothing new means nothing is said (no fixed slot)
  settleMs: 30000,             // once news arrives, wait this long for more to finish so it lands as one batch
  urgentGapMs: 90000,          // two interruptions are never closer than this
  coalesceMs: 8000,            // wait this long after an urgent signal so a burst becomes one interruption
  maxInterrupts: 4,            // per rolling window below; past the cap, urgent news waits for the digest
  interruptWindowMs: 30 * 60000,
  maxDigestItems: 5,           // more than this is named as a count, not read out
  maxQueue: 40,
  deadlineMs: 60 * 60000,      // a deadline inside the hour interrupts
  overdueGraceMs: 15 * 60000,  // a deadline this far past is digest news, not an interruption
  offerTimeoutMs: 2 * 60000,   // a delivery nobody acknowledged goes back in the queue
  maxWalkMs: 3 * 3600000,      // an Ambient Walk nobody stopped ends by itself
  quietHours: { start: '22:00', end: '07:00' },
});

const WORKER_STATE = { 'thread.idle': 'replied', 'thread.failed': 'failed', 'interaction.pending': 'needs-input' };
// Lower sorts first in a digest: what needs the user, then what broke, then what finished.
const RANK = { 'needs-input': 0, failed: 1, deadline: 2, replied: 3, commitment: 4 };

/**
 * The urgent criteria, in one place. Everything that is not urgent waits for the next digest.
 * - an agent the user is waiting on (it has a voice-dispatch receipt) replied or failed;
 * - a BB approval or question that only the user can answer;
 * - a deadline inside the hour (and not long past).
 * @returns {{level:'urgent'|'digest', reason:string}}
 */
export function classify(signal, { now = Date.now(), deadlineMs = AMBIENT_DEFAULTS.deadlineMs, overdueGraceMs = AMBIENT_DEFAULTS.overdueGraceMs } = {}) {
  if (signal.kind === 'worker') {
    if (signal.state === 'needs-input') return { level: 'urgent', reason: 'waiting on an approval or answer only you can give' };
    if (signal.awaited && signal.state === 'failed') return { level: 'urgent', reason: 'an agent you are waiting on failed' };
    if (signal.awaited && signal.state === 'replied') return { level: 'urgent', reason: 'an agent you are waiting on replied' };
    return { level: 'digest', reason: signal.state === 'failed' ? 'an agent hit an error' : 'an agent finished a turn' };
  }
  if (signal.kind === 'deadline') {
    const until = Date.parse(signal.dueAt) - now;
    if (Number.isFinite(until) && until <= deadlineMs && until >= -overdueGraceMs) return { level: 'urgent', reason: 'a deadline inside the hour' };
    return { level: 'digest', reason: Number.isFinite(until) && until < 0 ? 'an overdue deadline' : 'an upcoming deadline' };
  }
  return { level: 'digest', reason: 'recorded for today' };
}

/** Minutes since local midnight in the user's zone. */
function localMinutes(now, timeZone) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now)); }
  catch { parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now)); }
  const get = type => Number(parts.find(p => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
const toMinutes = hhmm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Quiet hours wrap midnight ("22:00"–"07:00"). A missing or equal pair means no quiet hours. */
export function inQuietHours(now, timeZone, quietHours = AMBIENT_DEFAULTS.quietHours) {
  const start = toMinutes(quietHours?.start), end = toMinutes(quietHours?.end);
  if (start === null || end === null || start === end) return false;
  const t = localMinutes(now, timeZone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const phrase = item => item.kind === 'deadline'
  ? `${item.title} is due ${item.dueAt ? `at ${item.dueLocal || item.dueAt}` : 'soon'}`
  : item.kind === 'commitment' ? `you noted: ${item.title}`
  : `${item.title} ${item.state === 'needs-input' ? 'needs you' : item.state === 'failed' ? 'hit an error' : 'replied'}`;

/**
 * What gets spoken. Short on purpose: it is read over music, by Siri or a brief session. Titles are
 * data. Replied never means done, so it is never phrased as done.
 * @returns {{title:string, body:string}}
 */
export function deliveryText(items, { kind = 'digest', more = 0 } = {}) {
  const lead = kind === 'urgent' ? (items.length === 1 ? 'Heads up' : `Heads up, ${items.length} things`) : `BB update, ${items.length + more === 1 ? 'one thing' : `${items.length + more} things`}`;
  const body = items.map(i => clean(phrase(i), 140)).join('; ') + (more ? `; and ${more} more when you look` : '') + '.';
  return { title: lead, body: clean(body.charAt(0).toUpperCase() + body.slice(1), 600) };
}

/**
 * The batcher. Pure state and a clock: no timers, no I/O. One entry per subject (thread or deadline),
 * latest state wins, and a state already spoken is never spoken again.
 */
export class AmbientBatcher {
  constructor(options = {}) {
    this.options = { ...AMBIENT_DEFAULTS, ...options };
    this.clock = options.clock ?? Date.now;
    this.timeZone = options.timeZone ?? 'UTC';
    this.enabled = false; this.startedAt = null;
    this.queue = new Map();    // subject -> signal
    this.spoken = new Map();   // subject -> state last actually delivered
    this.inflight = new Map(); // delivery id -> {items, offeredAt, kind}
    this.lastDigestAt = 0; this.interrupts = [];
  }
  start(now = this.clock(), overrides = {}) {
    // A fresh walk uses today's batching, not an interval restored from an older walk's saved state.
    this.options.intervalMs = AMBIENT_DEFAULTS.intervalMs;
    for (const key of ['intervalMs', 'quietHours']) if (overrides[key] !== undefined) this.options[key] = overrides[key];
    this.enabled = true; this.startedAt = now; this.lastDigestAt = now;
    return this.status(now);
  }
  // Stopping drops held news: the next walk starts from what is new then, and Pocket still shows it all.
  stop() { this.enabled = false; this.startedAt = null; this.queue.clear(); this.inflight.clear(); return this.status(); }
  status(now = this.clock()) {
    const nextDigestAt = this.enabled ? this.lastDigestAt + this.options.intervalMs : null;
    return { enabled: this.enabled, startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      queued: this.queue.size, urgentQueued: [...this.queue.values()].filter(s => this.#urgent(s, now)).length,
      inflight: this.inflight.size, quiet: inQuietHours(now, this.timeZone, this.options.quietHours),
      nextDigestAt: nextDigestAt ? new Date(nextDigestAt).toISOString() : null, intervalMs: this.options.intervalMs };
  }
  #urgent(signal, now) { return classify(signal, { now, deadlineMs: this.options.deadlineMs, overdueGraceMs: this.options.overdueGraceMs }).level === 'urgent'; }
  // A thread that replies twice is two pieces of news; the same event delivered twice is one. So a worker's
  // identity is its state plus the thread's updatedAt, the same key worker-events.mjs correlates on.
  #stateOf(signal) { return signal.kind === 'deadline' ? `due:${signal.dueAt}` : `${signal.state ?? signal.kind}@${signal.version ?? ''}`; }

  /** @returns {'queued'|'suppressed'|'ignored'} */
  offer(raw, now = this.clock()) {
    if (!this.enabled || !raw?.subject) return 'ignored';
    const signal = { ...raw, title: clean(raw.title || raw.subject, 160), at: raw.at ?? new Date(now).toISOString() };
    const state = this.#stateOf(signal);
    if (this.spoken.get(signal.subject) === state) { this.queue.delete(signal.subject); return 'suppressed'; }
    // Latest state wins, but awaited-ness is sticky: a thread the user was waiting on stays one they are waiting on.
    const previous = this.queue.get(signal.subject);
    this.queue.set(signal.subject, { ...signal, awaited: Boolean(signal.awaited || previous?.awaited), firstAt: previous?.firstAt ?? signal.at });
    while (this.queue.size > this.options.maxQueue) {
      const oldest = [...this.queue.values()].filter(s => !this.#urgent(s, now)).sort((a, b) => a.at.localeCompare(b.at))[0] ?? this.queue.values().next().value;
      this.queue.delete(oldest.subject);
    }
    return 'queued';
  }
  /** A live call already said it: record it so the digest does not say it again. */
  markSpoken(signal) { if (signal?.subject) { this.spoken.set(signal.subject, this.#stateOf(signal)); this.queue.delete(signal.subject); } }

  /**
   * What should be delivered now, if anything: at most one interruption and one digest. Items handed out
   * are held in flight until ack(); an unacknowledged delivery returns to the queue after offerTimeoutMs.
   * @returns {{interrupt:null|object, digest:null|object, status:object}}
   */
  /** Everything queued, now, as one digest (the user paused their music to hear it). Quiet hours still hold it. */
  flushNow(now = this.clock()) {
    const none = { interrupt: null, digest: null };
    if (!this.enabled || !this.queue.size || inQuietHours(now, this.timeZone, this.options.quietHours)) return { ...none, status: this.status(now) };
    const byRank = (a, b) => (this.#urgent(b, now) - this.#urgent(a, now)) || (RANK[a.state ?? a.kind] ?? 9) - (RANK[b.state ?? b.kind] ?? 9) || a.at.localeCompare(b.at);
    const all = [...this.queue.values()].sort(byRank);
    this.lastDigestAt = now;
    const digest = this.#offer('digest', all.slice(0, this.options.maxDigestItems), now, all.length - Math.min(all.length, this.options.maxDigestItems));
    return { interrupt: null, digest, status: this.status(now) };
  }
  tick(now = this.clock()) {
    const none = { interrupt: null, digest: null };
    if (!this.enabled) return { ...none, status: this.status(now) };
    if (now - this.startedAt > this.options.maxWalkMs) { this.stop(); return { ...none, status: { ...this.status(now), ended: 'time-limit' } }; }
    for (const [id, delivery] of this.inflight) if (now - delivery.offeredAt > this.options.offerTimeoutMs) {
      this.inflight.delete(id);
      for (const item of delivery.items) if (!this.queue.has(item.subject) && this.spoken.get(item.subject) !== this.#stateOf(item)) this.queue.set(item.subject, item);
    }
    // Quiet hours hold everything, urgent included; it is all still queued in the morning.
    if (inQuietHours(now, this.timeZone, this.options.quietHours)) return { ...none, status: this.status(now) };
    const o = this.options;
    this.interrupts = this.interrupts.filter(at => now - at < o.interruptWindowMs);
    const lastInterrupt = this.interrupts.at(-1) ?? -Infinity;
    const byRank = (a, b) => (this.#urgent(b, now) - this.#urgent(a, now)) || (RANK[a.state ?? a.kind] ?? 9) - (RANK[b.state ?? b.kind] ?? 9) || a.at.localeCompare(b.at);
    // The batch (user feedback, 2026-09-28: no fixed check-in; batch what finishes, at most every 2 minutes). News
    // opens a short window so things finishing together land as one; it never lands right on top of an
    // interruption, and it carries any urgent news too, so the user hears one delivery rather than two.
    const queued = [...this.queue.values()];
    if (queued.length && now - this.lastDigestAt >= o.intervalMs && now - lastInterrupt >= o.urgentGapMs) {
      const ages = queued.map(s => now - Date.parse(s.at));
      if (Math.min(...ages) >= (o.settleMs ?? 0) || Math.max(...ages) >= o.intervalMs) {
        this.lastDigestAt = now;
        const all = queued.sort(byRank);
        const digest = this.#offer('digest', all.slice(0, o.maxDigestItems), now, all.length - Math.min(all.length, o.maxDigestItems));
        return { interrupt: null, digest, status: this.status(now) };
      }
    }
    const urgent = [...this.queue.values()].filter(s => this.#urgent(s, now)).sort(byRank);
    if (!urgent.length || now - lastInterrupt < o.urgentGapMs || this.interrupts.length >= o.maxInterrupts) return { ...none, status: this.status(now) };
    // Coalesce a burst: wait until the newest urgent signal has settled, but never hold the oldest too long.
    const ages = urgent.map(s => now - Date.parse(s.at));
    if (Math.min(...ages) < o.coalesceMs && Math.max(...ages) < 4 * o.coalesceMs) return { ...none, status: this.status(now) };
    this.interrupts.push(now);
    const out = { interrupt: this.#offer('urgent', urgent.slice(0, o.maxDigestItems), now, Math.max(0, urgent.length - o.maxDigestItems)), digest: null };
    return { ...out, status: this.status(now) };
  }
  #offer(kind, items, now, more = 0) {
    const id = `amb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    for (const item of items) this.queue.delete(item.subject);
    this.inflight.set(id, { kind, items, offeredAt: now });
    const text = deliveryText(items, { kind, more });
    return { id, kind, ...text, count: items.length, more, subjects: items.map(i => i.subject),
      threadIds: items.map(i => i.threadId).filter(Boolean), reasons: items.map(i => classify(i, { now }).reason) };
  }
  /** The caller delivered it (spoken=true) or could not (spoken=false: it goes back in the queue now). */
  ack(id, { spoken = true } = {}) {
    const delivery = this.inflight.get(id);
    if (!delivery) return false;
    this.inflight.delete(id);
    for (const item of delivery.items) {
      if (spoken) this.spoken.set(item.subject, this.#stateOf(item));
      else if (!this.queue.has(item.subject)) this.queue.set(item.subject, item);
    }
    return true;
  }
  snapshot() {
    return { enabled: this.enabled, startedAt: this.startedAt, lastDigestAt: this.lastDigestAt, interrupts: this.interrupts,
      intervalMs: this.options.intervalMs, quietHours: this.options.quietHours,
      queue: [...this.queue.values()], spoken: [...this.spoken.entries()].slice(-200),
      inflight: [...this.inflight.entries()] };
  }
  restore(state) {
    if (!state) return this;
    Object.assign(this, { enabled: Boolean(state.enabled), startedAt: state.startedAt ?? null, lastDigestAt: state.lastDigestAt ?? 0, interrupts: state.interrupts ?? [] });
    if (state.intervalMs) this.options.intervalMs = state.intervalMs;
    if (state.quietHours !== undefined) this.options.quietHours = state.quietHours;
    for (const [subject, spokenState] of state.spoken ?? []) this.spoken.set(subject, spokenState);
    for (const item of state.queue ?? []) if (item?.subject && this.spoken.get(item.subject) !== this.#stateOf(item)) this.queue.set(item.subject, item);
    for (const [id, delivery] of state.inflight ?? []) this.inflight.set(id, delivery);
    return this;
  }
}

/** One BB worker event, as the ambient batcher sees it. `result` is what worker-events.mjs returned for it. */
export function workerSignal(event, data, result = {}) {
  const state = WORKER_STATE[event];
  const thread = data?.thread;
  if (!state || !thread?.id || thread.archivedAt || thread.deletedAt) return null;
  const awaited = Boolean(result?.updates?.length);
  // A child thread nobody assigned by voice is another agent's business; only top-level work reaches the user.
  if (!awaited && thread.parentThreadId && state !== 'needs-input') return null;
  return { kind: 'worker', subject: `thread:${thread.id}`, threadId: thread.id, state, awaited, version: thread.updatedAt ?? null,
    title: thread.title || thread.titleFallback || thread.id };
}

const AMBIENT_KEY = 'ambient:state';
/**
 * The batcher bound to durable storage, so a plugin reload neither re-speaks nor drops held news.
 * @param {{store:any, clock?:()=>number, timeZone?:string|(()=>string|Promise<string>)}} deps
 */
export function createAmbient({ store, clock = Date.now, timeZone = 'UTC' }) {
  const zone = async () => { try { return (typeof timeZone === 'function' ? await timeZone() : timeZone) || 'UTC'; } catch { return 'UTC'; } };
  let batcher = null, chain = Promise.resolve();
  const serial = fn => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };
  const load = async () => {
    const tz = await zone();
    if (!batcher) batcher = new AmbientBatcher({ clock, timeZone: tz }).restore(await store.get(AMBIENT_KEY));
    batcher.timeZone = tz;
    return batcher;
  };
  const save = b => store.set(AMBIENT_KEY, b.snapshot());
  return {
    start: opts => serial(async () => { const b = await load(); const s = b.start(clock(), opts ?? {}); await save(b); return s; }),
    stop: () => serial(async () => { const b = await load(); const s = b.stop(); await save(b); return s; }),
    status: () => serial(async () => (await load()).status(clock())),
    poll: () => serial(async () => { const b = await load(); const r = b.tick(clock()); await save(b); return r; }),
    flush: () => serial(async () => { const b = await load(); const r = b.flushNow(clock()); await save(b); return r; }),
    ack: (id, opts) => serial(async () => { const b = await load(); const ok = b.ack(id, opts); await save(b); return { acknowledged: ok }; }),
    offer: signal => serial(async () => { const b = await load(); if (!b.enabled) return 'ignored'; const r = b.offer(signal, clock()); await save(b); return r; }),
    /** A test check-in from Pocket's button: it must play now, so it isn't held by the interruption cap or gap. */
    offerTest: signal => serial(async () => { const b = await load(); if (!b.enabled) return 'ignored'; b.interrupts = []; const r = b.offer(signal, clock()); await save(b); return r; }),
    /** Wired after the worker-event handler: a live call that already spoke it marks it spoken instead. */
    observe: (event, data, result) => serial(async () => {
      const b = await load();
      const signal = workerSignal(event, data, result);
      if (!b.enabled || !signal) return 'ignored';
      if (result?.spoken) { b.markSpoken(signal); await save(b); return 'spoken-live'; }
      const r = b.offer(signal, clock()); await save(b); return r;
    }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Thought bubble. A thought is the user's own, not work: it never enters receipts (action:*), bb_outstanding, the
// continuity record, digests, worker briefs or any thread. Stored one key per thought in the plugin's own
// kv, which lives in bb.db on the BB server: durable, not in any git working tree, not read by the
// user's other tools, and readable only through this plugin's thought RPC.

export const THOUGHT_SOURCES = ['siri', 'action-button', 'control', 'walk', 'voice', 'app'];
const clientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const thoughtInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('capture'), text: z.string().trim().min(1).max(4000), capturedVia: z.enum(THOUGHT_SOURCES).default('app'),
    clientId: clientId.nullable().default(null), capturedAt: z.string().datetime({ offset: true }).nullable().default(null) }).strict(),
  z.object({ op: z.literal('list'), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  z.object({ op: z.literal('delete'), id: z.string().regex(/^tht_[a-z0-9]{16}$/) }).strict(),
]);
export const ambientInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), intervalMs: z.number().int().min(2 * 60000).max(30 * 60000).optional(),
    quietHours: z.object({ start: z.string().regex(/^\d{1,2}:\d{2}$/), end: z.string().regex(/^\d{1,2}:\d{2}$/) }).nullable().optional() }).strict(),
  z.object({ op: z.literal('stop') }).strict(),
  z.object({ op: z.literal('status') }).strict(),
  z.object({ op: z.literal('poll') }).strict(),
  // The user paused their music: deliver whatever is waiting now, as one digest, instead of at the next slot.
  z.object({ op: z.literal('flush') }).strict(),
  z.object({ op: z.literal('ack'), id: z.string().regex(/^amb_[a-z0-9]{16}$/), spoken: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal('deadline'), id: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(160),
    dueAt: z.string().datetime({ offset: true }) }).strict(),
]);

/** The minimal acknowledgement. Nothing is read back: repeating the idea over music is the interruption. */
export const THOUGHT_ACK = 'Got it.';

/**
 * Durable capture: write, read back, compare. A retry with the same clientId (Siri retries, flaky signal)
 * returns the first record instead of a duplicate.
 */
export async function captureThought(store, input, { now = () => new Date(), sessionId = null } = {}) {
  const at = now().toISOString();
  const text = String(input.text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 4000);
  if (!text) throw new Error('There was nothing to write down.');
  const indexKey = input.clientId ? `thought-client:${input.clientId}` : null;
  if (indexKey) {
    const known = await store.get(indexKey);
    const previous = known && await store.get(known);
    if (previous) return { thought: publicThought(previous), stored: true, reused: true, ack: THOUGHT_ACK };
  }
  const id = `tht_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const record = { key: `thought:${at}:${id}`, id, text, at, capturedAt: input.capturedAt ?? at, source: 'thought bubble',
    capturedVia: input.capturedVia ?? 'app', sessionId, visibility: 'personal' };
  await store.set(record.key, record);
  const check = await store.get(record.key);
  if (check?.text !== text) throw new Error('The thought could not be confirmed as saved. Say it did not save.');
  if (indexKey) await store.set(indexKey, record.key);
  return { thought: publicThought(record), stored: true, ack: THOUGHT_ACK };
}
const publicThought = r => ({ id: r.id, text: r.text, at: r.at, capturedAt: r.capturedAt, source: r.source, capturedVia: r.capturedVia });

/** One note by id, or null. */
export async function findThoughtById(store, id) {
  const key = (await store.list('thought:')).find(k => k.endsWith(`:${id}`));
  const record = key && await store.get(key);
  return record ? publicThought(record) : null;
}

/**
 * Delete one note: its record, its client-id index (Siri retries), and its words in the notebook's
 * transcripts. Idempotent: deleting a note that is already gone reports deleted:false, not an error.
 */
export async function deleteThought(store, id) {
  const keys = (await store.list('thought:')).filter(k => k.endsWith(`:${id}`));
  for (const key of keys) await store.delete(key);
  for (const key of keys) if (await store.get(key)) throw new Error('The note could not be confirmed as deleted.');
  if (keys.length) for (const index of await store.list('thought-client:')) if (keys.includes(await store.get(index))) await store.delete(index);
  await scrubNote(store, id);
  return { id, deleted: keys.length > 0 };
}

export async function listThoughts(store, { limit = 50 } = {}) {
  const keys = (await store.list('thought:')).sort().slice(-limit).reverse();
  return (await Promise.all(keys.map(key => store.get(key)))).filter(Boolean).map(publicThought);
}

/** The in-call path: "thought bubble" or "Manager, write this down" during a live Walk. */
export const thoughtToolSchema = z.object({
  text: z.string().trim().min(1).max(4000).describe('The idea as the user dictated it, in their words. No summary, no additions.'),
  request: z.string().trim().min(2).max(1600).describe('Quote the user’s actual words from THIS live conversation that asked for it to be written down.'),
}).strict();
/** Reading them back: only when the user asks for their own notes. Searches the whole collection, newest first. */
export const recallToolSchema = z.object({
  query: z.string().trim().max(200).nullable().describe('Words from the note to look for, or null for the most recent notes.'),
  since: z.string().datetime({ offset: true }).nullable().describe('Only notes captured at or after this time, or null.'),
  limit: z.number().int().min(1).max(20).describe('How many notes to return at most, e.g. 5.'),
}).strict();
/** Deleting one: found by recall first, named back to the user, and confirmed in their own words after that. */
export const forgetToolSchema = z.object({
  id: z.string().regex(/^tht_[a-z0-9]{16}$/).describe('The id of the note, exactly as bb_recall_thoughts returned it in this call.'),
  request: z.string().trim().min(2).max(1600).describe('Quote the user’s own words from THIS live conversation, said after you named the note back to them, confirming it should be deleted.'),
}).strict();
export const thoughtDefinitions = [{ type: 'function', name: 'bb_capture_thought', strict: true,
  description: 'Write down a personal idea when the user says "thought bubble", "write this down", "take note of this", or addresses the manager to capture an idea. It is theirs, not work: it assigns nothing, is not a commitment, and must never be put into an agent brief, a thread, or a summary of what is outstanding. After it saves, say only "Got it" and let them carry on; do not read it back or ask follow-up questions.',
  parameters: z.toJSONSchema(thoughtToolSchema) },
{ type: 'function', name: 'bb_recall_thoughts', strict: true,
  description: 'Read back the user\'s own captured notes (thoughts written down earlier with bb_capture_thought, Siri or the app, in any earlier call or walk) when they ask what they noted, wrote down or captured. This is the only place those notes are: bb_search searches threads and cannot find them. Personal: tell only the user; never put a note into an agent brief, a thread, or a summary of what is outstanding. If nothing matches, say which notes you searched (the result says how many), not that the note does not exist.',
  parameters: z.toJSONSchema(recallToolSchema) },
{ type: 'function', name: 'bb_forget_thought', strict: true,
  description: 'Delete one of the user\'s own captured notes when they ask to delete, remove or forget it. First find it with bb_recall_thoughts, then name it back in a few words ("the one about the pricing page?") and wait: only their confirmation after that authorizes the delete, and request must quote it. One note per call; if several match, ask which. After it is deleted say only "Deleted." Never delete a note the user did not ask about.',
  parameters: z.toJSONSchema(forgetToolSchema) }];

/** Every note, newest first, filtered by time and words (all words match first; any word as a fallback). */
export async function findThoughts(store, { query = null, since = null, limit = 5 } = {}) {
  const keys = (await store.list('thought:')).sort().reverse();
  const all = (await Promise.all(keys.map(key => store.get(key)))).filter(Boolean)
    .filter(r => !since || Date.parse(r.capturedAt ?? r.at) >= Date.parse(since));
  const words = normalizeRequest(query ?? '').split(' ').filter(w => w.length > 1);
  const text = r => normalizeRequest(r.text);
  let hits = all, match = 'recent';
  if (words.length) {
    hits = all.filter(r => words.every(w => text(r).includes(w))); match = 'all words';
    if (!hits.length) { hits = all.filter(r => words.some(w => text(r).includes(w))); match = 'any word'; }
  }
  return { thoughts: hits.slice(0, limit).map(publicThought), matched: hits.length, searched: all.length,
    oldest: all.at(-1)?.capturedAt ?? null, match };
}

/**
 * Tool handler. The request must be in this call's own speech, like every other write. The turn is then
 * blanked in the continuity log so the idea is not replayed into the next call's resume briefing.
 */
/** @param {{store:any, requests:any, sessionId:string, now?:()=>Date, onCaptured?:(thought:any)=>void, onDeleted?:(id:string)=>void}} deps */
export function createThoughtTool({ store, requests, sessionId, now = () => new Date(), onCaptured = () => {}, onDeleted = () => {} }) {
  // A retried tool call must still find its turn after that turn was blanked, so the original words are
  // kept here, in memory, for this call only.
  const blanked = new Map();
  // Notes read back in this call, with how far the conversation had got when they were: a delete needs
  // the user's confirmation from after that point.
  const recalled = new Map();
  return async function captureFromCall(name, raw) {
    if (name === 'bb_recall_thoughts') {
      const args = recallToolSchema.parse(raw);
      const found = await findThoughts(store, args);
      for (const t of found.thoughts) recalled.set(t.id, requests.count ?? 0);
      return { ...found,
        note: 'These are the user\'s personal notes. Tell them only what they asked for; never put a note into a brief, a thread or an agent instruction.' };
    }
    if (name === 'bb_forget_thought') {
      const args = forgetToolSchema.parse(raw);
      if (!recalled.has(args.id)) throw new ActionError('Find the note with bb_recall_thoughts first, name it back to the user in a few words, and wait for them to confirm.');
      const { turn } = requests.authorize(args.request);
      if (turn <= recalled.get(args.id)) throw new ActionError('Name the note back to the user in a few words and wait: their confirmation after that is the request. Nothing was deleted.');
      const result = await deleteThought(store, args.id);
      recalled.delete(args.id);
      try { onDeleted(args.id); } catch {}
      return { deleted: true, id: args.id, alreadyGone: !result.deleted, note: 'Deleted. Say only "Deleted." and do not repeat the note.' };
    }
    if (name !== 'bb_capture_thought') throw new Error('Unknown thought tool.');
    const args = thoughtToolSchema.parse(raw);
    let turn;
    try { ({ turn } = requests.authorize(args.request)); }
    catch (error) {
      const quote = normalizeRequest(args.request);
      turn = quote && [...blanked].find(([original]) => original.includes(quote))?.[1];
      if (!turn) throw error;
    }
    const clientId = createHash('sha256').update(`${sessionId}|${turn}|${normalizeRequest(args.text)}`).digest('hex').slice(0, 32);
    const result = await captureThought(store, { text: args.text, capturedVia: 'voice', clientId }, { now, sessionId });
    const part = requests.parts?.find(p => p.id === turn);
    if (part && !blanked.has(normalizeRequest(part.text)) && !part.private) { blanked.set(normalizeRequest(part.text), turn); part.text = '[a private thought was captured here]'; part.private = true; }
    // Other logs of this call (the walk's history) blank it too, so it isn't replayed into the next call.
    try { onCaptured(result.thought); } catch {}
    return { stored: true, id: result.thought.id, reused: Boolean(result.reused),
      note: 'Saved. Say only "Got it." Do not repeat the idea, do not mention it again unless asked, and never include it in a brief to an agent.' };
  };
}

/** Routes the in-call thought tool to its handler and everything else to the session's own query. */
export const THOUGHT_TOOLS = ['bb_capture_thought', 'bb_recall_thoughts', 'bb_forget_thought'];
export const withThoughtTool = (next, tool) => (name, args) => (THOUGHT_TOOLS.includes(name) ? tool(name, args) : next(name, args));

const localClock = (iso, timeZone) => { try { return new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };

/** The `ambient` RPC, so server.ts stays a one-line route. */
export async function ambientRpc(ambient, input, { timeZone = 'UTC' } = {}) {
  if (input.op === 'start') return ambient.start({ intervalMs: input.intervalMs, quietHours: input.quietHours });
  if (input.op === 'stop') return ambient.stop();
  if (input.op === 'status') return ambient.status();
  if (input.op === 'poll') return ambient.poll();
  if (input.op === 'flush') return ambient.flush();
  if (input.op === 'ack') return ambient.ack(input.id, { spoken: input.spoken });
  const signal = { kind: 'deadline', subject: `deadline:${input.id}`, title: input.title, dueAt: input.dueAt, dueLocal: localClock(input.dueAt, timeZone) };
  // Pocket's "Send test check-in" uses ids starting "test": those skip the interruption cap (a test must play).
  return { result: await (/^test/.test(input.id) && ambient.offerTest ? ambient.offerTest(signal) : ambient.offer(signal)) };
}

/** The `thought` RPC: capture from Siri, the Action Button, a control or the app; list the user's own; delete one. */
export async function thoughtRpc(store, input, { now } = {}) {
  if (input.op === 'list') return { thoughts: await listThoughts(store, { limit: input.limit }) };
  if (input.op === 'delete') return deleteThought(store, input.id);
  return captureThought(store, input, { now });
}
