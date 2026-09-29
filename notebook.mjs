// Created: 2026-09-28. The notebook: a durable record of every voice conversation, from any surface (the bb
// panel, Pocket's Walk, "Hey BB" calls and live check-ins), so the user can read back at the computer what was
// said, what was done and what was noted. It is a view of the user's own record, not a channel into agents:
// nothing here is read by a voice tool, a worker brief, a receipt, a digest, continuity or bb_outstanding.
// One kv key per conversation (`notebook:<id>`); the id starts with its start time, so keys sort by time.
import { z } from 'zod';

export const NOTEBOOK_LIMITS = Object.freeze({
  maxSessions: 200,              // keep at most this many conversations...
  maxAgeMs: 30 * 24 * 3600000,   // ...and none older than this, whichever is smaller
  maxTextBytes: 160_000,         // per conversation; kv values are capped at 256 KB
  maxTurns: 1500,
  maxActions: 60,
  saveEveryMs: 5000,             // a live call is written at most this often, and again when it ends
});
export const NOTEBOOK_SURFACES = ['panel', 'walk', 'hey-bb', 'check-in'];
const PREFIX = 'notebook:';
const ID = /^\d{13}-[0-9a-f-]{36}$/;
export const notebookId = z.string().regex(ID);
export const notebookInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  z.object({ op: z.literal('get'), id: notebookId }).strict(),
]);

/**
 * Which surface a call came from. The start context says Hey BB and check-ins outright; a call opened from
 * a check-in the user said yes to carries only its ambientId. Otherwise Pocket (a native app, no browser UA) is
 * Walk and anything with a browser user agent is the bb panel.
 */
export function surfaceOf(context = {}, { userAgent = '' } = {}) {
  if (context.source === 'hey-bb') return 'hey-bb';
  if (context.source === 'checkin' || context.ambientId) return 'check-in';
  const ua = String(userAgent ?? '');
  if (ua && !/Mozilla\//.test(ua)) return 'walk';
  return 'panel';
}

const startOf = id => { const ms = Number(String(id).slice(0, 13)); return Number.isFinite(ms) ? ms : 0; };
const bytes = text => Buffer.byteLength(text, 'utf8');
const clean = text => String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ');
const receiptView = r => ({ key: r.key ?? null, id: r.id, kind: r.kind, status: r.status, title: String(r.title ?? '').slice(0, 200),
  threadId: r.threadId ?? null, model: r.model ?? null, at: r.at ?? null, workerState: r.workerState ?? null });
export const NOTE_DELETED = '[a note captured here was later deleted]';
// Who spoke a turn, as a reader sees it: the manager (and a check-in) is BB, a direct line is its thread's title.
export const MANAGER_LABEL = 'BB';
const cleanThread = t => /^thr_[a-z0-9]+$/.test(String(t?.threadId ?? ''))
  ? { threadId: t.threadId, title: clean(t.title ?? '').trim().slice(0, 200) || t.threadId } : null;
const labelOf = turn => turn.speaker === 'you' ? 'You' : turn.label ?? (turn.speaker === 'thread' ? 'Thread' : MANAGER_LABEL);

// Conversations being recorded right now. A note deleted mid-call is scrubbed here too, so the next save
// cannot write the deleted words back. Writes go through one chain so they land in order.
const live = new Set();
let chain = Promise.resolve();
const serial = fn => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

function scrubEntry(entry, noteId) {
  let changed = false;
  for (const turn of entry.turns) if (turn.noteId === noteId && !turn.noteDeleted) { turn.text = NOTE_DELETED; turn.noteDeleted = true; changed = true; }
  if (entry.notes.includes(noteId)) { entry.notes = entry.notes.filter(n => n !== noteId); changed = true; }
  return changed;
}

/**
 * A note was deleted: blank every transcript turn it was captured from, live and stored. Called by
 * deleteThought, so every delete path (voice, RPC, panel) scrubs the notebook the same way.
 */
export async function scrubNote(store, noteId) {
  for (const recorder of live) if (scrubEntry(recorder.entry, noteId)) recorder.dirty = true;
  return serial(async () => {
    let scrubbed = 0;
    for (const key of await store.list(PREFIX)) {
      const entry = await store.get(key);
      if (entry?.turns && scrubEntry(entry, noteId)) { await store.set(key, entry); scrubbed++; }
    }
    return scrubbed;
  });
}

// Runs as a conversation opens, so it leaves room for that one and never drops it.
async function prune(store, { now, limits, opening }) {
  const keys = (await store.list(PREFIX)).filter(key => key !== opening).sort();
  const cutoff = now - limits.maxAgeMs;
  const drop = keys.filter(key => startOf(key.slice(PREFIX.length)) < cutoff);
  const kept = keys.filter(key => !drop.includes(key));
  drop.push(...kept.slice(0, Math.max(0, kept.length - (limits.maxSessions - 1))));
  for (const key of drop) await store.delete(key);
  return drop.length;
}

/**
 * @param {{store:any, now?:()=>number, limits?:Partial<typeof NOTEBOOK_LIMITS>}} deps
 */
export function createNotebook({ store, now = Date.now, limits: overrides = {} }) {
  const limits = { ...NOTEBOOK_LIMITS, ...overrides };
  const iso = () => new Date(now()).toISOString();

  /**
   * Start (or, for a continued walk, resume) recording one conversation. Returns the recorder the voice
   * route feeds; every method is safe to call after close (it does nothing).
   */
  async function open({ id, surface, context = {}, continued = false }) {
    if (!ID.test(id ?? '')) return null;
    const key = `${PREFIX}${id}`;
    const entry = await serial(async () => {
      await prune(store, { now: now(), limits, opening: key }).catch(() => 0);
      const existing = continued ? await store.get(key) : undefined;
      if (existing?.turns) { existing.endedAt = null; return existing; }
      // legs counts voice sessions (manager, direct thread lines, reconnects); each one calls leg() as it starts.
      return { key, id, surface: NOTEBOOK_SURFACES.includes(surface) ? surface : 'panel', startedAt: iso(), endedAt: null,
        seconds: 0, reason: null, legs: 0, ambientRun: context.ambientRun ?? null, threadId: context.threadId ?? null,
        turns: [], actions: [], notes: [], textBytes: 0, truncated: false };
    });
    const recorder = { entry, dirty: true, closed: false, timer: null };
    live.add(recorder);
    const save = () => {
      clearTimeout(recorder.timer); recorder.timer = null;
      if (!recorder.dirty) return Promise.resolve();
      recorder.dirty = false;
      return serial(() => store.set(key, entry)).catch(() => { recorder.dirty = true; });
    };
    const touch = () => {
      recorder.dirty = true;
      if (!recorder.timer && !recorder.closed) { recorder.timer = setTimeout(() => void save(), limits.saveEveryMs); recorder.timer.unref?.(); }
    };
    // A new leg's first words (a continued walk, a direct thread line, the manager coming back) start a new
    // turn rather than joining the previous leg's last one.
    let joinable = false;
    const push = (speaker, text, extra = {}) => {
      if (entry.truncated) return;
      const size = bytes(text);
      if (entry.textBytes + size > limits.maxTextBytes || entry.turns.length >= limits.maxTurns) { entry.truncated = true; touch(); return; }
      const last = entry.turns.at(-1);
      if (joinable && last && last.speaker === speaker && (last.threadId ?? null) === (extra.threadId ?? null)
        && !extra.typed && !last.typed && !last.noteDeleted) last.text += text;
      else entry.turns.push({ speaker, text, at: iso(), ...extra });
      entry.textBytes += size; joinable = true; touch();
    };
    void save();
    return {
      id, key,
      /**
       * A transcript delta: {speaker:'you'|'assistant', text}. Deltas from one speaker join into one turn. On a
       * direct thread line, pass that thread: its voice is recorded under the thread's title, not as BB.
       * @param {{speaker?:string,text?:string}} [delta]
       * @param {{thread?:{threadId:string,title?:string}|null,worker?:boolean}} [options]
       */
      transcript({ speaker, text } = {}, { thread = null, worker = false } = {}) {
        if (recorder.closed || typeof text !== 'string' || !text) return;
        if (speaker === 'you') return push('you', clean(text));
        const line = cleanThread(thread);
        if (line) return push('thread', clean(text), { label: line.title, threadId: line.threadId });
        push(worker ? 'thread' : 'bb', clean(text), { label: worker ? 'Thread' : MANAGER_LABEL });
      },
      /** A voice session starts in this conversation: the manager, a direct thread line, or a reconnect. */
      leg() {
        if (recorder.closed) return;
        entry.legs = (entry.legs ?? 0) + 1; joinable = false; touch();
      },
      /**
       * A direct line to a thread opened or closed. Kept with the actions (linked to the thread), one row per
       * line: opened, then returned (back to the manager) or ended (the call ended on the line).
       * @param {{state?:'opened'|'returned'|'ended',target?:{threadId:string,title?:string}}} [line]
       */
      workerLine({ state, target } = {}) {
        const line = cleanThread(target);
        if (recorder.closed || !line || !['opened', 'returned', 'ended'].includes(state)) return;
        const open = entry.actions.findLast(a => a.kind === 'worker-line' && a.threadId === line.threadId && a.status === 'opened');
        if (state !== 'opened') { if (open) { open.status = state; open.endedAt = iso(); touch(); } return; }
        if (entry.actions.length >= limits.maxActions) return;
        const n = entry.actions.filter(a => a.kind === 'worker-line').length + 1;
        entry.actions.push({ key: null, id: `line-${n}`, kind: 'worker-line', status: 'opened', title: line.title, threadId: line.threadId,
          model: null, at: iso(), endedAt: null, workerState: null });
        touch();
      },
      /** A typed question from the panel: its own turn. */
      typed(text) { if (!recorder.closed && typeof text === 'string' && text.trim()) push('you', clean(text).slice(0, 2000), { typed: true }); },
      /** An action receipt (new or updated): kept by id, latest state wins. */
      action(receipt) {
        if (recorder.closed || !receipt?.id) return;
        const view = receiptView(receipt);
        const at = entry.actions.findIndex(a => a.id === view.id);
        if (at >= 0) entry.actions[at] = view; else if (entry.actions.length < limits.maxActions) entry.actions.push(view);
        touch();
      },
      /** A note was captured in this call: the user turn it came from is tagged with it. */
      note(thought) {
        if (recorder.closed || !thought?.id) return;
        if (!entry.notes.includes(thought.id)) entry.notes.push(thought.id);
        const turn = [...entry.turns].reverse().find(t => t.speaker === 'you' && !t.noteId);
        if (turn) turn.noteId = thought.id;
        touch();
      },
      /**
       * The call (or this connection of a continued walk) ended: stamp it and write it now. Duration is wall
       * time from the first leg's start to now, so direct thread lines and reconnects all count.
       */
      async close({ reason = 'ended' } = {}) {
        if (recorder.closed) return;
        recorder.closed = true; live.delete(recorder);
        for (const a of entry.actions) if (a.kind === 'worker-line' && a.status === 'opened') { a.status = 'ended'; a.endedAt = iso(); }
        entry.endedAt = iso(); entry.reason = reason;
        entry.seconds = Math.max(0, Math.round((now() - Date.parse(entry.startedAt)) / 1000));
        recorder.dirty = true;
        await save();
      },
      flush: save,
      get entry() { return entry; },
    };
  }

  /** Newest first, with a one-line preview. The transcript itself comes from get(). */
  async function list({ limit = 100 } = {}) {
    const cutoff = now() - limits.maxAgeMs;
    const keys = (await store.list(PREFIX)).filter(k => startOf(k.slice(PREFIX.length)) >= cutoff).sort().reverse().slice(0, limit);
    const rows = (await Promise.all(keys.map(k => store.get(k)))).filter(e => e?.turns);
    return { sessions: rows.map(e => {
      const first = e.turns.find(t => t.speaker === 'you' && !t.noteId && t.text.trim()) ?? e.turns.find(t => t.text.trim());
      return { id: e.id, surface: e.surface, startedAt: e.startedAt, endedAt: e.endedAt, seconds: e.seconds ?? 0, legs: Math.max(1, e.legs ?? 1),
        turnCount: e.turns.length, actionCount: e.actions.length, noteCount: e.notes.length, truncated: Boolean(e.truncated),
        preview: first ? first.text.replace(/\s+/g, ' ').trim().slice(0, 160) : '' };
    }), limits: { maxSessions: limits.maxSessions, maxAgeDays: Math.round(limits.maxAgeMs / 86400000) } };
  }

  /**
   * One conversation in full. Every turn carries its speaker's label (You, BB, or the thread's title) and, on
   * a direct thread line, the threadId and an @thread link, so any reader can name who was talking. Actions are re-read from their receipts so a worker that replied after the
   * call shows its current state; notes are resolved to their current text (a deleted note reads as deleted).
   */
  /** @param {string} id @param {{findNote?:(id:string)=>Promise<object|null>}} [options] */
  async function get(id, { findNote = async () => null } = {}) {
    if (!ID.test(id ?? '')) return { session: null };
    const e = await store.get(`${PREFIX}${id}`);
    if (!e?.turns) return { session: null };
    const actions = await Promise.all(e.actions.map(async a => {
      const current = a.key ? await store.get(a.key).catch(() => null) : null;
      const { key: _key, ...view } = current ? receiptView(current) : a; // the kv key stays server-side (and undefined is not JSON)
      return { ...view, link: view.threadId ? `@thread:${view.threadId}` : null };
    }));
    const notes = (await Promise.all(e.notes.map(async noteId => (await findNote(noteId)) ?? { id: noteId, deleted: true })));
    return { session: { id: e.id, surface: e.surface, startedAt: e.startedAt, endedAt: e.endedAt, seconds: e.seconds ?? 0, legs: Math.max(1, e.legs ?? 1),
      reason: e.reason, truncated: Boolean(e.truncated),
      turns: e.turns.map(t => ({ speaker: t.speaker, label: labelOf(t), text: t.text, at: t.at,
        ...(t.threadId ? { threadId: t.threadId, link: `@thread:${t.threadId}` } : {}),
        ...(t.typed ? { typed: t.typed } : {}), ...(t.noteId ? { noteId: t.noteId } : {}), ...(t.noteDeleted ? { noteDeleted: t.noteDeleted } : {}) })),
      actions, notes } };
  }

  return { open, list, get };
}
