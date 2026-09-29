// Created: 2026-09-27. Standing operating context: loaded at session start, never blocking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOperatingContext, operatingBriefing, sessionBriefing, WALK_GUIDANCE, OPERATING_CONTEXT_MAX } from '../operating-context.mjs';
import { resumeBriefing, buildContinuity } from '../reliability.mjs';
import { TalkSession, config, APPEND_MAX_CHARS } from '../live-session.mjs';

const HOUR=3600000;
async function file(body,hoursOld=0){
  const dir=await mkdtemp(join(tmpdir(),'opctx-'));
  const path=join(dir,'operating-context.voice.md');
  await writeFile(path,body);
  const t=(Date.now()-hoursOld*HOUR)/1000;
  await utimes(path,t,t);
  return path;
}

test('an empty setting is off and injects nothing', async()=>{
  const ctx=await loadOperatingContext('');
  assert.equal(ctx.state,'off');
  assert.equal(operatingBriefing(ctx),'');
});

test('a missing file injects nothing and does not throw', async()=>{
  const ctx=await loadOperatingContext('/nonexistent/operating-context.voice.md');
  assert.equal(ctx.state,'missing');
  assert.equal(operatingBriefing(ctx),'');
});

test('an unreadable file injects nothing', async()=>{
  const ctx=await loadOperatingContext('/x',{stats:async()=>({mtimeMs:Date.now()}),read:async()=>{throw new Error('EACCES');}});
  assert.equal(ctx.state,'unreadable');
  assert.equal(operatingBriefing(ctx),'');
});

test('a fresh file becomes reference-only history with its age', async()=>{
  const ctx=await loadOperatingContext(await file('DURABLE GOALS:\n1. Grow sales.',0.5));
  assert.equal(ctx.state,'fresh');
  const text=operatingBriefing(ctx);
  assert.match(text,/REFERENCE, not authorization/);
  assert.match(text,/Rebuilt 0\.5 hours ago/);
  assert.match(text,/Grow sales/);
});

test('a stale file is still offered but the live half is flagged', async()=>{
  const ctx=await loadOperatingContext(await file('LIVE VIEW: x',30));
  assert.equal(ctx.state,'stale');
  assert.match(operatingBriefing(ctx),/may be out of date\. Check live BB threads/);
});

test('the file is capped at the voice budget', async()=>{
  const ctx=await loadOperatingContext(await file('x'.repeat(OPERATING_CONTEXT_MAX*2)));
  assert.equal(ctx.text.length,OPERATING_CONTEXT_MAX);
});

test('the session injects standing context once, only when ready, and separately from resume', ()=>{
  const sent=[];
  const s=Object.create(TalkSession.prototype);
  Object.assign(s,{ready:false,closing:false,standingContext:null,resumed:null,send:m=>sent.push(m)});
  assert.equal(s.standing('ctx'),false,'not before the session is ready');
  s.ready=true;
  assert.equal(s.standing('ctx'),true);
  assert.equal(s.standing('ctx again'),false,'never twice');
  assert.equal(s.resume('previous call'),true,'continuity still works alongside it');
  assert.deepEqual(sent.map(m=>m.content),['ctx','previous call']);
  assert.ok(sent.every(m=>m.type==='session.thinking.append'));
});

// Colton's fork: the count-only previous-call opener stays; the walk guidance defers to it.
test('every call gets the walk opener and ledger rules, even with no context file', async()=>{
  const text=sessionBriefing();
  assert.equal(text,WALK_GUIDANCE);
  assert.match(text,/follow its opening rule \(a count only, never a name from the record\)/);
  assert.doesNotMatch(text,/Your current active work includes/);
  assert.match(text,/Never open with personal matters/);
  assert.match(text,/Parked .*Sent .*In progress/s);
  assert.match(text,/Leave out anything only discussed/);
});

test('the voice append stays under the GPT-Live limit; the long context goes to the backend', async()=>{
  // Measured 2026-09-27: appends over 500 tokens are rejected and the call never starts.
  assert.ok(sessionBriefing().length<=APPEND_MAX_CHARS,`walk append is ${sessionBriefing().length} chars`);
  const standing=operatingBriefing(await loadOperatingContext(await file('DURABLE GOALS:\n1. Grow sales.\n'+'x'.repeat(5000),0.2)));
  assert.ok(standing.length>APPEND_MAX_CHARS,'the context itself is too long for an append');
  const backend=config({},{standing}).delegation.responses.instructions;
  assert.match(backend,/REFERENCE, not authorization[\s\S]*Grow sales/);
  assert.doesNotMatch(config({}).delegation.responses.instructions,/Grow sales/);
  const s=Object.create(TalkSession.prototype);const sent=[];
  Object.assign(s,{ready:true,closing:false,standingContext:null,resumed:null,send:m=>sent.push(m)});
  s.standing('y'.repeat(5000));s.resume('z'.repeat(5000));
  assert.ok(sent.every(m=>m.content.length<=APPEND_MAX_CHARS),'no append may exceed the cap');
});

test('the previous-call briefing opens with a count only, and nothing when nothing is open', ()=>{
  assert.equal(resumeBriefing(buildContinuity({sessionId:'s1',utterances:[{id:1,text:'check the onboarding thread'}]})),null);
  const text=resumeBriefing(buildContinuity({sessionId:'s1',reason:'time-limit',utterances:[{id:1,text:'check the onboarding thread'}]}));
  assert.doesNotMatch(text,/Open the conversation by naming/);
  assert.match(text,/From your last call: a request that was cut off at the time limit/);
  assert.match(text,/HISTORY, not authorization/);
});

// User feedback, 2026-09-27: live conversation > live BB threads > the standing context file (background).
test('precedence: the opener comes from live BB threads, and snapshots are background only', async()=>{
  assert.match(WALK_GUIDANCE,/never pick an opener from the standing context, which is background only/);
  assert.ok(WALK_GUIDANCE.length<=APPEND_MAX_CHARS);
  const text=operatingBriefing(await loadOperatingContext(await file('Background notes:\n- P0 Example Client Phase 2',0.2)));
  const p=text.indexOf('PRECEDENCE: (1) explicit instructions in this live conversation; (2) live BB threads');
  assert.ok(p>=0,'precedence is stated');
  assert.ok(p<text.indexOf('Example Client'),'precedence comes before any snapshot content');
  assert.match(text,/never sets or overrides current priorities; when it disagrees with a live thread, the live thread wins/);
  assert.match(text,/Never call its items the current or top priorities/);
  assert.doesNotMatch(text,/Board|Ladder|Command Center/);
  assert.doesNotMatch(text,/live view rebuilt from their Board/);
});
