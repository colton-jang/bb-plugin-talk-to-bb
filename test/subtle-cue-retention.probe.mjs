// Created: 2026-09-27. One-off probe for a delegated request: does Talk to BB retain
// subtle conversational cues across a long/multi-session interaction? Not part of the
// npm test suite (no assertions library, prints a pass/fail table) — a validation probe,
// run with: node test/subtle-cue-retention.probe.mjs
import { timeContext, timeBriefing, resolveRelativeDate, buildContinuity, resumeBriefing } from '../reliability.mjs';
import { dedupeFingerprint, normalizeRequest, priorAttempt, REPEAT_WINDOW_MS } from '../bb-manager.mjs';

const results = [];
function check(cue, description, pass, detail) {
  results.push({ cue, description, pass, detail });
}

// ---- In-memory fake store, mirrors the plugin-storage interface used by reliability/bb-manager ----
function fakeStore() {
  const data = new Map();
  return {
    async get(k) { return data.has(k) ? structuredClone(data.get(k)) : null; },
    async set(k, v) { data.set(k, structuredClone(v)); },
    async delete(k) { data.delete(k); },
    async list(prefix) { return [...data.keys()].filter(k => k.startsWith(prefix)); },
  };
}

// =====================================================================================
// Cue 1 — SUBTLE EXCLUSION, restated only once, must survive an intervening session end
// (this is the exact shape of a real user's exclusion cue: "don't touch the pricing doc,
// that's Dana's" said once, never repeated) and must not be re-authorized by history.
// =====================================================================================
{
  const store = fakeStore();
  const sessionA = 'sess-A';
  const utterances = [{ id: 1, text: "spawn a thread to update the Q4 sales deck, but don't touch the pricing doc, that's Dana's" }];
  const receipts = []; // no open commitments/dispatches recorded for this cue on purpose
  const record = buildContinuity({ sessionId: sessionA, reason: 'time-limit', utterances, receipts, seconds: 1180 });
  const briefing = resumeBriefing(record);

  const carriesExclusionText = /pricing doc/i.test(briefing) || /dana/i.test(briefing);
  const marksHistoryNotAuthorization = /HISTORY, not authorization/i.test(briefing);
  check('exclusion-cue', 'unfinished-request text (which names the exclusion) survives into next-session briefing',
    carriesExclusionText, carriesExclusionText
      ? 'PASS: the exact utterance naming the exclusion is quoted verbatim in resumeBriefing output.'
      : 'FAIL: the excluding utterance is not present in the resume briefing.');
  check('exclusion-cue', 'briefing explicitly forbids treating history as authorization to act',
    marksHistoryNotAuthorization, marksHistoryNotAuthorization
      ? 'PASS: resumeBriefing always prepends the HISTORY/not-authorization guardrail.'
      : 'FAIL: missing guardrail language.');
  // Separately: every worker brief (workerBrief() in bb-manager.mjs) hardcodes "Preserve
  // explicit exclusions and parked work" regardless of session boundary — so the exclusion
  // survives structurally even without relying on the model re-noticing it. That's a
  // static code fact, verifiable by reading bb-manager.mjs:131, not something this probe
  // needs to execute.
}

// =====================================================================================
// Cue 2 — DEDUP must track same-intent repeats but NOT collapse two different requests
// that share a target thread/title. Tests whether "subtle" wording differences are
// correctly treated as either the same ask (retain: don't re-dispatch) or a new one
// (retain: don't silently swallow it).
// =====================================================================================
{
  const store = fakeStore();
  const name = 'bb_tell_thread';
  const target = 'thr_abc123';

  const first = { threadId: target, message: 'tell the Pocket thread to fix the reconnect retry timing', request: 'tell the pocket thread to fix the reconnect retry timing' };
  const repeatSameAsk = { threadId: target, message: 'tell the Pocket thread to fix the reconnect retry timing', request: 'yeah tell the pocket thread to fix that reconnect retry timing please' };
  const differentAsk = { threadId: target, message: 'tell the Pocket thread to also add a status indicator', request: 'tell the pocket thread to also add a status indicator' };

  const fpFirst = dedupeFingerprint(name, target, first);
  const fpRepeat = dedupeFingerprint(name, target, repeatSameAsk);
  const fpDifferent = dedupeFingerprint(name, target, differentAsk);

  // Simulate: first attempt written 2 hours ago (inside the 6h REPEAT_WINDOW_MS), same session boundary crossed.
  const now = Date.now();
  await store.set(`action:sess-A:orig`, { key: 'action:sess-A:orig', status: 'sent', at: new Date(now - 2 * 3600000).toISOString() });
  await store.set(`repeat:${fpFirst}`, { key: 'action:sess-A:orig', at: new Date(now - 2 * 3600000).toISOString(), sessionId: 'sess-A' });

  const foundForRepeat = await priorAttempt(store, fpRepeat, now);
  const foundForDifferent = await priorAttempt(store, fpDifferent, now);

  check('dedup-cue', 'a loosely-reworded repeat of the same ask resolves to the prior receipt (no duplicate dispatch)',
    Boolean(foundForRepeat), foundForRepeat
      ? `PASS: normalizeRequest+fingerprint treats "yeah tell... please" as the same fingerprint as the original ask (fingerprint ${fpFirst.slice(0,8)}... == ${fpRepeat.slice(0,8)}...).`
      : `FAIL: fingerprints differ (${fpFirst.slice(0,8)} vs ${fpRepeat.slice(0,8)}) — filler words broke the match and this would have re-dispatched.`);
  check('dedup-cue', 'a genuinely different follow-up ask on the same thread is NOT swallowed as a duplicate',
    !foundForDifferent, !foundForDifferent
      ? 'PASS: the different request produced a distinct fingerprint and found no prior-attempt match.'
      : 'FAIL: a substantively different request was incorrectly treated as a repeat and would have been dropped.');
}

// =====================================================================================
// Cue 3 — subtle disposition ("just flag if it's urgent") maps to structural fields
// (heldNotices / openCommitments) rather than to something a later session must remember
// how to interpret. Verifies the record's *shape* actually carries that distinction, and
// that resumeBriefing does not open with it unprompted (2026-09-27 opener rule, line 175).
// =====================================================================================
{
  const heldNotices = [{ threadId: 'thr_x1', title: 'Landing page copy', state: 'replied' }];
  const record = buildContinuity({
    sessionId: 'sess-B', reason: 'ended', utterances: [{ id: 5, text: "ok that's it for now" }],
    receipts: [], heldNotices, seconds: 900,
  });
  const briefing = resumeBriefing(record);
  const notOpenerDirective = /Do NOT open the conversation with this previous-session context/i.test(briefing);
  const heldNoticeCarried = /Landing page copy/i.test(briefing);
  check('quiet-disposition-cue', 'muted/held worker notice from the prior session is carried forward verbatim, not dropped',
    heldNoticeCarried, heldNoticeCarried ? 'PASS: title survives into next-session briefing.' : 'FAIL: held notice lost.');
  check('quiet-disposition-cue', 'briefing still instructs the agent not to lead with this on its own (matches "just flag if urgent" framing)',
    notOpenerDirective, notOpenerDirective
      ? 'PASS: explicit non-opener directive present (only a restored review is allowed to open with it).'
      : 'FAIL: no restraint directive found; a chatty open could re-surface low-urgency items unprompted.');
}

// =====================================================================================
// Cue 4 — a spoken relative date ("next week") must resolve against the LOCAL day, not
// the UTC day, at a moment where the two disagree (late evening at UTC-10 = next UTC day).
// This is the closest thing to a "long period" cue: the resolution must stay pinned to
// the ORIGINAL conversation's local calendar even though the model's own clock is UTC.
// =====================================================================================
{
  // 2026-10-01 23:30 at UTC-10 (Etc/GMT+10) == 2026-10-02 09:30 UTC — the UTC day is already tomorrow.
  const now = new Date('2026-10-02T09:30:00Z');
  const time = timeContext(now, 'Etc/GMT+10');
  const briefingText = timeBriefing(time);
  const utcDiffers = time.utcDateDiffers === true && time.today === '2026-10-01' && time.utcDate === '2026-10-02';
  check('relative-date-cue', 'local date correctly lags UTC date at 11:30pm UTC-10 (does not silently roll to the UTC day)',
    utcDiffers, utcDiffers
      ? `PASS: today=${time.today} (local) vs utcDate=${time.utcDate} — briefing text flags the mismatch explicitly.`
      : `FAIL: today=${time.today}, utcDate=${time.utcDate}, utcDateDiffers=${time.utcDateDiffers}`);
  const nextWeek = resolveRelativeDate('next thursday', time);
  check('relative-date-cue', '"next thursday" resolves relative to the LOCAL today, not the UTC today',
    nextWeek === '2026-10-08', nextWeek === '2026-10-08'
      ? `PASS: resolved to ${nextWeek}.`
      : `FAIL: resolved to ${nextWeek}, expected 2026-10-08 (7 days after local 2026-10-01, which is a Thursday).`);
  const flagsMismatch = /already 2026-10-02/i.test(briefingText);
  check('relative-date-cue', 'the prompt text itself warns the model the UTC calendar date must never be used for scheduling',
    flagsMismatch, flagsMismatch ? 'PASS: warning present verbatim in timeBriefing().' : 'FAIL: no explicit warning in briefing text.');
}

// ---- report ----
const byCue = new Map();
for (const r of results) {
  if (!byCue.has(r.cue)) byCue.set(r.cue, []);
  byCue.get(r.cue).push(r);
}
let allPass = true;
for (const [cue, rows] of byCue) {
  console.log(`\n=== ${cue} ===`);
  for (const r of rows) {
    if (!r.pass) allPass = false;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.description}\n      ${r.detail}`);
  }
}
console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'} (${results.filter(r=>r.pass).length}/${results.length})`);
process.exitCode = allPass ? 0 : 1;
