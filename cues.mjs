// Created: 2026-09-27. Responsiveness cues: short, sparse signs of life while a BB tool call is awaited.
//
// Silence is measured from the last thing the user actually heard (assistant playback, the
// user's own speech, or a previous cue), and only while at least one tool call is pending.
// A cue is one session.commentary.append asking the voice model for a few words, plus a
// visual line for the panel. Nothing here ever reports a result: the moment the last pending
// call returns, the schedule is dropped and the model's real answer takes over.

/**
 * Timing profiles. Every number is milliseconds of SILENCE before that cue, counted from
 * the last sound, not from when the tool started.
 * - first: the acknowledgement. Skipped when the assistant already said something after the
 *   call started (it has acknowledged on its own) and whenever the tool returns first.
 * - progress: the next cues, in order. repeat: the gap after those run out (null = stop).
 * - max: cap on cues for one wait.
 */
export const CUE_PROFILES = Object.freeze({
  off: null,
  // subtle (user feedback, 2026-09-27): a soft device-side sound from 2.5 s while work is pending
  // (earcon), then ONE spoken "still working on that" at 8 s, then nothing. No spoken ack.
  subtle: Object.freeze({ earcon: 2500, first: null, progress: Object.freeze([8000]), repeat: null, max: 1 }),
  steady: Object.freeze({ first: 2000, progress: Object.freeze([7000]), repeat: 15000, max: 4 }),
  chatty: Object.freeze({ first: 1500, progress: Object.freeze([6000]), repeat: 10000, max: 6 }),
});
export const CUE_PROFILE_NAMES = Object.freeze(Object.keys(CUE_PROFILES));
export function cueProfile(name) {
  return Object.hasOwn(CUE_PROFILES, name) ? CUE_PROFILES[name] : null;
}

// Output playback is 16 kHz mono PCM16: 32 bytes per millisecond. Audio reaches the server
// faster than it plays, so speech is modelled as a playback clock, not the last delta's time.
const BYTES_PER_MS = 32;
const TRANSCRIPT_TAIL_MS = 400;

// Measured 2026-09-27 on a real GPT-Live session: the service streams output audio CONTINUOUSLY,
// about 32 KB/s of digital silence (peak amplitude 0) while the backend works. Treating every
// byte as speech kept the silence clock pinned at zero, so no cue of any profile ever fired in a
// real call; the unit tests only fed audio during speech and could not see it. Only audible
// samples count as speech.
export const AUDIBLE_PEAK = 256;
/** @param {Uint8Array|ArrayBuffer|null|undefined} bytes PCM16 little-endian */
export function isAudible(bytes) {
  if (!bytes) return false;
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (let i = 0; i + 1 < view.length; i += 2) {
    let s = view[i] | (view[i + 1] << 8); if (s & 0x8000) s -= 0x10000;
    if (s > AUDIBLE_PEAK || s < -AUDIBLE_PEAK) return true;
  }
  return false;
}

const ACTIONS = new Set(['bb_spawn_thread', 'bb_tell_thread', 'bb_stop_thread']);
/** Pseudo-call the session reports while the backend is working out an answer or its next
 * tool call: the silence BEFORE any tool exists (reasoning, or writing a long dispatch brief). */
export const BACKEND_THINKING = '__backend__';
// Four things the user can be waiting on; kind picks the words inside a category.
const CATEGORY = { lookup: 'lookup', screen: 'lookup', focus: 'lookup', dispatch: 'dispatch', relay: 'dispatch',
  stopping: 'dispatch', agent: 'agent', approval: 'approval', thinking: 'thinking' };
const PRIORITY = ['approval', 'agent', 'dispatch', 'relay', 'stopping', 'focus', 'screen', 'lookup', 'thinking'];

/**
 * What the silence is about, from the tool name and what earlier lookups showed about the
 * target thread. Review-mode tools get no cue: review is meant to be quiet.
 * @param {string} name
 * @param {any} args
 * @param {Map<string,{running:boolean,blocked:boolean}>} [known]
 * @returns {string|null}
 */
export function cueKind(name, args, known = new Map()) {
  if (typeof name !== 'string' || name.startsWith('bb_review_')) return null;
  if (name === BACKEND_THINKING) return 'thinking';
  if (name === 'bb_view_screen') return 'screen';
  if (name === 'bb_focus_thread') return 'focus';
  if (name === 'bb_spawn_thread') return 'dispatch';
  if (name === 'bb_tell_thread' || name === 'bb_stop_thread') {
    const thread = known.get(args?.threadId);
    if (thread?.blocked) return 'approval';
    if (name === 'bb_stop_thread') return 'stopping';
    return thread?.running ? 'agent' : 'relay';
  }
  return 'lookup';
}

// Example wording per kind: [acknowledgements, progress]. None of them reports an outcome.
export const CUE_PHRASES = Object.freeze({
  lookup: [['Checking BB now.', 'One sec, looking.', 'Let me look.'],
    ['Still reading through it.', 'Still checking.', 'Still going through the threads.']],
  screen: [['Taking a look.', 'One sec, grabbing a snapshot.'],
    ['Still waiting on the snapshot.', 'Still getting the screen.']],
  focus: [['Opening it for you.', 'Switching your browser over.'],
    ['Still waiting for your browser to switch.', 'Your browser hasn’t switched yet.']],
  dispatch: [['Setting up an agent.', 'Handing that off now.', 'Starting an agent on it.'],
    ['Still starting the agent; no confirmation yet.', 'Still waiting for BB to start it.']],
  relay: [['Sending that over.', 'Passing that along.'],
    ['Still waiting for BB to confirm delivery.', 'Still sending; not confirmed yet.']],
  stopping: [['Stopping it now.', 'Asking it to stop.'],
    ['Still waiting for the stop to go through.', 'The stop hasn’t confirmed yet.']],
  agent: [['That agent is mid-task; passing it along.', 'It’s still working, so I’m slipping this in.'],
    ['Still getting it to the agent while it works.', 'The agent’s busy; still delivering.']],
  approval: [['Heads up: that thread is waiting on your approval.', 'That one’s blocked on an approval only you can give.'],
    ['Still sending, but the approval is yours to give.', 'Still waiting; only you can clear that approval.']],
  thinking: [['One moment.', 'Give me a second.', 'Working on it.'],
    ['Still working on that.', 'Still on it.', 'Still thinking that through.']],
});

const WHAT = {
  lookup: 'a BB lookup you started is still running',
  screen: 'the screen snapshot you asked for has not come back yet',
  focus: 'the browser has not yet confirmed it opened the thread',
  dispatch: 'the agent you are starting has not been confirmed as started yet',
  relay: 'the message you are sending to an agent has not been confirmed as delivered yet',
  stopping: 'the stop you requested has not been confirmed yet',
  agent: 'you are relaying a message to an agent that is still busy on its task; delivery is not confirmed yet',
  approval: 'the thread you are messaging is blocked on a BB approval that only the user can give; your message will not clear it and delivery is not confirmed yet',
  thinking: 'you are still working out the answer or the next step; nothing has been looked up, sent or started yet',
};
export const VISUAL = {
  lookup: 'Still checking BB', screen: 'Waiting for the snapshot', focus: 'Waiting for the browser',
  dispatch: 'Starting the agent (not confirmed yet)', relay: 'Sending (not confirmed yet)',
  stopping: 'Stopping (not confirmed yet)', agent: 'Agent busy; delivering (not confirmed yet)',
  approval: 'Blocked on your approval', thinking: 'Working on it',
};

/**
 * The commentary the voice model receives. Stays far below the 500-token append limit
 * (tests pin it under 1,800 characters for every kind and stage).
 */
export function cueText({ kind, stage, seconds, phrase, avoid = [] }) {
  const ack = stage === 'ack';
  return `Silence cue, not news: ${WHAT[kind] || WHAT.lookup}, and the user has heard nothing for about ${seconds} seconds. `
    + `${ack ? 'Acknowledge it' : 'Give one brief sign you are still on it'} in a few natural words, e.g. "${phrase}". `
    + `Vary the wording${avoid.length ? ` and do not reuse ${avoid.map(p => `"${p}"`).join(', ')}` : ''}. `
    + 'No filler sounds such as mm or uh-huh. Do not say or imply that anything is done, found, sent, started or fixed, and do not guess at the result. '
    + (kind === 'approval' ? 'Make clear the approval is still the user’s to give; you cannot answer it. ' : '')
    + 'If the result has already arrived or the user is talking, skip this and carry on.';
}

/** Threads a lookup result describes, with what matters for wording: running, blocked. */
export function observedThreads(result) {
  const rows = [];
  if (result?.thread) rows.push(result.thread);
  if (Array.isArray(result?.threads)) rows.push(...result.threads);
  for (const group of ['active', 'archived']) for (const row of result?.[group]?.results ?? []) rows.push(row?.thread);
  if (Array.isArray(result?.results)) for (const row of result.results) rows.push(row?.thread);
  return rows.filter(t => t && typeof t.id === 'string');
}

/**
 * Attach cue timing to a TalkSession. Reads only its public events and flags, and speaks only
 * through session.send, so the session itself needs no knowledge of profiles.
 * @param {import('./live-session.mjs').TalkSession} session
 * @param {{profile?:string, onCue?:(cue:object)=>void, onEarcon?:(state:object)=>void, now?:()=>number, random?:()=>number}} [options]
 */
export function attachCues(session, { profile = 'off', onCue = () => {}, onEarcon = () => {}, now = () => Date.now(), random = Math.random } = {}) {
  const timing = cueProfile(profile);
  const noop = { profile: timing ? profile : 'off', enabled: false, pending: new Map(), known: new Map(), dispose() {}, state() { return null; } };
  if (!timing) return noop;
  const pending = new Map(); // call id -> kind
  const known = new Map();   // thread id -> {running, blocked}
  const used = [];
  let timer = null, episode = null, speechUntil = 0, heardAt = 0, disposed = false;
  // Earcon: a device-side sound (the panel plays it), separate from the voice model. It never
  // speaks, so it needs no commentary append, and it stops the moment anything is heard.
  let earconTimer = null, earconOn = false, earconOffTimer = null;
  // Measured on a real session: a tool finishing and the backend's next thought are ~0.1-0.2 s
  // apart. Going idle waits this long before stopping, so the sound does not hiccup there.
  const EARCON_IDLE_GRACE_MS = 500;

  const current = () => {
    let best = null;
    for (const kind of pending.values()) if (best === null || PRIORITY.indexOf(kind) < PRIORITY.indexOf(best)) best = kind;
    return best;
  };
  const hasAck = timing.first != null;
  const gapFor = index => {
    const steps = [...(hasAck ? [timing.first] : []), ...timing.progress];
    if (index < steps.length) return steps[index];
    return timing.repeat;
  };
  const nextGap = () => {
    if (!episode || episode.sent >= timing.max) return null;
    return gapFor(episode.sent + (episode.skipFirst && hasAck ? 1 : 0));
  };
  const anchor = () => Math.max(episode?.startedAt ?? 0, heardAt, speechUntil, episode?.lastCueAt ?? 0);
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const earconAllowed = () => session.ready && session.audible && !session.reviewing && !session.closing;
  const stopEarcon = reason => {
    if (earconTimer) { clearTimeout(earconTimer); earconTimer = null; }
    if (!earconOn) return;
    if (reason === 'idle') {
      if (!earconOffTimer) earconOffTimer = setTimeout(() => {
        earconOffTimer = null;
        if (earconOn && !pending.size) { earconOn = false; onEarcon({ on: false, reason: 'idle' }); }
      }, EARCON_IDLE_GRACE_MS);
      return;
    }
    if (earconOffTimer) { clearTimeout(earconOffTimer); earconOffTimer = null; }
    earconOn = false; onEarcon({ on: false, reason });
  };
  const scheduleEarcon = () => {
    if (timing.earcon == null || disposed || !episode || !pending.size) return;
    if (!earconAllowed()) { stopEarcon('held'); return; }
    if (earconOn) { if (earconOffTimer) { clearTimeout(earconOffTimer); earconOffTimer = null; } return; } // work resumed in the grace window
    if (earconTimer) clearTimeout(earconTimer);
    const quietSince = Math.max(episode.startedAt, heardAt, speechUntil);
    earconTimer = setTimeout(() => {
      earconTimer = null;
      if (disposed || !episode || !pending.size || !earconAllowed()) return;
      if (now() < Math.max(episode.startedAt, heardAt, speechUntil) + timing.earcon) { scheduleEarcon(); return; }
      earconOn = true; onEarcon({ on: true, kind: current(), category: CATEGORY[current()] });
    }, Math.max(0, quietSince + timing.earcon - now()));
  };
  const schedule = () => {
    clear();
    if (disposed || !episode || !pending.size) return;
    if (session.closing) { dispose(); return; }
    scheduleEarcon();
    const gap = nextGap();
    if (gap == null) return;
    timer = setTimeout(fire, Math.max(0, anchor() + gap - now()));
  };
  const fire = () => {
    timer = null;
    if (disposed || !episode || !pending.size) return;
    if (session.closing) { dispose(); return; }
    const gap = nextGap();
    if (gap == null) return;
    const at = now();
    if (at < anchor() + gap) { schedule(); return; } // someone spoke; silence restarted
    const kind = current();
    const stage = hasAck && episode.sent === 0 && !episode.skipFirst ? 'ack' : 'progress';
    const bank = CUE_PHRASES[kind][stage === 'ack' ? 0 : 1];
    const fresh = bank.filter(p => !used.includes(p));
    const choices = fresh.length ? fresh : bank.filter(p => p !== used[used.length - 1]);
    const phrase = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
    const seconds = Math.max(1, Math.round((at - episode.startedAt) / 1000));
    const silent = Math.max(1, Math.round((at - anchor()) / 1000));
    // Quiet, review and a not-ready session hold the voice entirely. The panel line still
    // updates, because a visual cue talks over nobody.
    const voiced = session.ready && session.audible && !session.reviewing;
    let content = null;
    if (voiced) {
      content = cueText({ kind, stage, seconds: silent, phrase, avoid: used.slice(-3) });
      session.send({ type: 'session.commentary.append', delegation_id: null, content });
      used.push(phrase); if (used.length > 12) used.shift();
    }
    episode.sent++; episode.lastCueAt = at;
    onCue({ kind, category: CATEGORY[kind], stage, seconds, silentSeconds: silent, spoken: voiced, phrase: voiced ? phrase : null,
      text: `${VISUAL[kind]} · ${seconds}s`, suppressed: voiced ? null : !session.audible ? 'quiet' : session.reviewing ? 'review' : 'not-ready' });
    schedule();
  };
  // Ending a wait drops the timer but keeps the episode dormant rather than discarding it: a
  // model that chains several quick tool calls back to back (a poll loop) never says anything
  // in between, so the user's silence is continuous even though each individual call resolves
  // well under the first-cue threshold. Only a call that returns is not enough to say the
  // schedule should restart from zero — only something the user actually heard is.
  const end = () => { clear(); stopEarcon('idle'); if (episode) episode.dormantAt = now(); };

  const onLookup = event => {
    if (disposed || !event) return;
    const id = event.id ?? event.name;
    if (event.state === 'reading') {
      let args = event.args;
      if (args === undefined && typeof event.arguments === 'string') { try { args = JSON.parse(event.arguments); } catch { args = null; } }
      const kind = cueKind(event.name, args, known);
      if (!kind) return;
      pending.set(id, kind);
      if (!episode) episode = { startedAt: now(), sent: 0, skipFirst: false, lastCueAt: 0, dormantAt: null };
      else if (episode.dormantAt != null) {
        // Resume the same wait unless the user actually heard something (assistant speech or
        // their own voice) while no call was pending; that is the only thing that means the
        // prior wait is really over.
        const heardSinceDormant = heardAt > episode.dormantAt || speechUntil > episode.dormantAt;
        if (heardSinceDormant) episode = { startedAt: now(), sent: 0, skipFirst: false, lastCueAt: 0, dormantAt: null };
        else episode.dormantAt = null;
      }
      schedule();
      return;
    }
    if (event.state === 'done' && !ACTIONS.has(event.name)) for (const t of observedThreads(event.result))
      known.set(t.id, { running: ['active', 'starting'].includes(t.status), blocked: t.hasPendingInteraction === true });
    // A backend failure carries no call id: nothing is being waited on any more.
    if (event.name === 'backend') pending.clear(); else pending.delete(id);
    if (!pending.size) end(); else schedule();
  };
  const onAudio = bytes => {
    if (disposed || !isAudible(bytes)) return; // streamed silence is not speech
    const at = now();
    speechUntil = Math.max(speechUntil, at) + (bytes?.length ?? 0) / BYTES_PER_MS;
    stopEarcon('speech');
    if (episode && episode.sent === 0) episode.skipFirst = true; // it acknowledged on its own
    if (pending.size) schedule();
  };
  const onTranscript = t => {
    if (disposed) return;
    const at = now();
    if (t?.speaker === 'assistant') {
      speechUntil = Math.max(speechUntil, at + TRANSCRIPT_TAIL_MS);
      if (episode && episode.sent === 0) episode.skipFirst = true;
    } else heardAt = at;
    stopEarcon('speech');
    if (pending.size) schedule();
  };
  const onFlush = () => { speechUntil = Math.min(speechUntil, now()); if (session.closing) stopEarcon('closed'); };
  const onChange = () => { if (!earconAllowed()) stopEarcon('held'); if (pending.size) schedule(); };
  const dispose = () => {
    if (disposed) return;
    end(); disposed = true; pending.clear();
    session.off('lookup', onLookup); session.off('audio', onAudio); session.off('transcript', onTranscript);
    session.off('flush', onFlush); session.off('playback', onChange); session.off('review', onChange); session.off('closed', dispose);
  };
  session.on('lookup', onLookup); session.on('audio', onAudio); session.on('transcript', onTranscript);
  session.on('flush', onFlush); session.on('playback', onChange); session.on('review', onChange); session.on('closed', dispose);
  return { profile, enabled: true, pending, known, dispose, earcon: () => earconOn,
    state: () => (episode && pending.size) ? { kind: current(), sent: episode.sent, skipFirst: episode.skipFirst } : null };
}
