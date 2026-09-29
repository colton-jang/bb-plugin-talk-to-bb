// Created: 2026-09-29. Colton's fork merged with Chaning's v0.3.0: the paths the merge review found untested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContinuity, resumeBriefing } from '../reliability.mjs';
import { APPEND_MAX_CHARS } from '../live-session.mjs';

const receipt = (i, text) => ({ key: `receipt:${i}`, id: `r${i}`, kind: 'bb_note_commitment', status: 'open', summary: text, at: new Date(Date.UTC(2026, 8, 29, 7, i)).toISOString() });

test('the count-only opening rule survives the append cap, ahead of long quoted notes', () => {
  const record = buildContinuity({ sessionId: 's1', receipts: [1, 2, 3].map(i => receipt(i, `note ${i} `.padEnd(400, 'x'))) });
  const text = resumeBriefing(record).slice(0, APPEND_MAX_CHARS);
  assert.match(text, /From your last call: 3 recorded notes still open\./);
  assert.match(text, /Do not name, title or describe any item until the user asks/);
});

test('back from a direct thread line, the manager gets the history but no "From your last call" opener', () => {
  const record = buildContinuity({ sessionId: 's1', receipts: [receipt(1, 'call the vet')] });
  const text = resumeBriefing(record, { midCall: true });
  assert.doesNotMatch(text, /From your last call: /);
  assert.match(text, /mid-call, back from a direct thread line/);
  assert.match(text, /call the vet/);
});

test('a walk handoff or provider expiry at the limit keeps the cut-off request, like the time limit', () => {
  const utterances = [{ id: 1, text: 'and then tell the pocket thread to' }];
  for (const reason of ['time-limit', 'handoff', 'provider-expired'])
    assert.equal(buildContinuity({ sessionId: 's1', reason, utterances }).unfinishedRequest?.text, 'and then tell the pocket thread to', reason);
  assert.equal(buildContinuity({ sessionId: 's1', reason: 'ended', utterances }).unfinishedRequest, null);
});
