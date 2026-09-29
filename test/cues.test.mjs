// Created: 2026-09-27. Responsiveness cues: timing per profile, suppression, honest wording.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { TalkSession } from '../live-session.mjs';
import { attachCues, cueProfile, cueKind, cueText, CUE_PROFILES, CUE_PROFILE_NAMES, CUE_PHRASES, VISUAL } from '../cues.mjs';

// Words that would tell the user work is finished. A cue may never carry one.
const COMPLETION=/\b(done|finished|complete|completed|found (it|them)|sent it|started it|all set|got it|here it is|fixed|ready)\b/i;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
// Audible PCM16 (GPT-Live also streams all-zero silence, which must NOT count as speech).
const speech=bytes=>{const b=Buffer.alloc(bytes);for(let i=0;i+1<bytes;i+=2)b.writeInt16LE(i%64<32?3000:-3000,i);return b;};

function harness({profile='steady'}={}){
  const sent=[],cues=[],pending=new Map();
  const session=new TalkSession({key:'test',query:(name)=>new Promise((resolve,reject)=>pending.set(name,{resolve,reject}))});
  session.socket={readyState:1,bufferedAmount:0,send:value=>sent.push(JSON.parse(value)),close(){},terminate(){}};
  session.ready=true;
  const tracker=attachCues(session,{profile,onCue:cue=>cues.push({...cue,at:Date.now()}),random:()=>0});
  let n=0;
  const call=(name,args={})=>{
    const id=`call_${++n}`,delegation=`d${n}`;
    session.handle({type:'response.event',delegation_id:delegation,event:{type:'response.created',response:{id:`r${n}`}}});
    session.handle({type:'response.event',delegation_id:delegation,event:{type:'response.output_item.done',
      item:{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}}});
    return id;
  };
  const answer=async(name,result={})=>{await flush();pending.get(name).resolve(result);pending.delete(name);await flush();};
  const commentary=()=>sent.filter(e=>e.type==='session.commentary.append');
  return {session,sent,cues,tracker,call,answer,commentary};
}
function withClock(fn){
  return async()=>{
    mock.timers.enable({apis:['setTimeout','Date'],now:0});
    try { await fn(); } finally { mock.timers.reset(); }
  };
}
function tickBy(ms,step=100){ for(let t=0;t<ms;t+=step)mock.timers.tick(step); }

test('profiles: off is the default and unknown names fall back to off',()=>{
  assert.deepEqual(CUE_PROFILE_NAMES,['off','subtle','steady','chatty']);
  assert.equal(cueProfile('off'),null);
  assert.equal(cueProfile('loud'),null);
  assert.equal(cueProfile('__proto__'),null);
  for(const name of ['steady','chatty']){
    const p=CUE_PROFILES[name];
    assert.ok(p.first>=1500&&p.first<=2500,`${name} acknowledges after 1.5–2.5 s`);
    assert.ok(p.progress[0]>=6000&&p.progress[0]<=8000,`${name} first progress cue at 6–8 s`);
  }
  // subtle (user feedback, 2026-09-27): a sound from 2.5 s, one spoken check-in at 8 s, nothing else.
  assert.deepEqual({...CUE_PROFILES.subtle,progress:[...CUE_PROFILES.subtle.progress]},{earcon:2500,first:null,progress:[8000],repeat:null,max:1});
});

test('off sends nothing, however long the silence',withClock(async()=>{
  const h=harness({profile:'off'});
  assert.equal(h.tracker.enabled,false);
  h.call('bb_search',{query:'contracts'});
  tickBy(120000,1000);
  assert.equal(h.commentary().length,0);
  assert.equal(h.cues.length,0);
  assert.equal(h.session.listenerCount('audio'),0,'off attaches no listeners');
}));

// Silence is measured from the last cue, so each cue lands one gap after the one before.
const EXPECTED={subtle:[8000],steady:[2000,9000,24000,39000],chatty:[1500,7500,17500,27500,37500,47500]};
for(const [profile,times] of Object.entries(EXPECTED)){
  test(`${profile}: cues land at ${times.join(', ')} ms of an unbroken wait, then stop at the cap`,withClock(async()=>{
    const h=harness({profile});
    h.call('bb_search',{query:'contracts'});
    tickBy(120000);
    assert.deepEqual(h.cues.map(c=>c.at),times);
    const hasAck=CUE_PROFILES[profile].first!=null;
    assert.deepEqual(h.cues.map(c=>c.stage),times.map((_,i)=>hasAck&&i===0?'ack':'progress'));
    assert.equal(h.commentary().length,times.length);
    assert.ok(h.cues.every(c=>c.spoken&&c.category==='lookup'));
    h.session.clear();
  }));
}

test('a tool that returns before the first gap produces no cue at all',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.call('bb_read_thread',{threadId:'thr_a'});
  tickBy(1400);
  await h.answer('bb_read_thread',{thread:{id:'thr_a',status:'idle'}});
  tickBy(60000);
  assert.equal(h.commentary().length,0);
  assert.equal(h.cues.length,0);
  assert.equal(h.tracker.state(),null);
}));

test('once the tool returns, nothing further is said about it',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.call('bb_search',{query:'x'});
  tickBy(2000);
  assert.equal(h.commentary().length,1);
  await h.answer('bb_search',{});
  tickBy(60000);
  assert.equal(h.commentary().length,1,'no cue after the result is in');
}));

test('if the assistant already acknowledged, the first cue is skipped and silence is counted from its speech',withClock(async()=>{
  const h=harness({profile:'steady'});
  h.call('bb_search',{query:'x'});
  tickBy(500);
  h.session.emit('audio',speech(32000)); // one second of playback, arriving at once
  tickBy(20000);
  // Playback ends at 1500 ms; the progress gap of 7 s runs from there.
  assert.equal(h.cues[0].at,8500);
  assert.equal(h.cues[0].stage,'progress');
  assert.match(h.commentary()[0].content,/Give one brief sign you are still on it/);
}));

// Root cause of the live "subtle produced no cue" report: a chain of quick tool calls (a poll
// loop, or a spawn immediately followed by a wait on the spawned agent) with nothing said in
// between used to reset the episode to zero on every call boundary, so no single call ever ran
// long enough alone to cross the first-cue gap even though the user heard nothing for the whole
// chain. The fix keeps the wait's clock running across such a chain; only something actually
// heard (assistant speech or the user talking) may reset it.
test('a chain of quick polls with nothing said between them still gets a cue for the whole silent stretch',withClock(async()=>{
  const h=harness({profile:'subtle'});
  for(let i=0;i<6;i++){
    h.call('bb_read_thread',{threadId:'thr_demo'});
    tickBy(1500);
    await h.answer('bb_read_thread',{thread:{id:'thr_demo',status:'active'}});
    tickBy(500); // brief gap before the next poll; nothing was said in it
  }
  assert.ok(h.cues.length>0,'12s of silent polling produced at least one cue');
  assert.ok(h.cues.every(c=>c.spoken&&c.kind==='lookup'));
}));

test('a brief spoken acknowledgment before a dispatch does not suppress the cue for the whole rest of the wait',withClock(async()=>{
  const h=harness({profile:'subtle'});
  // The manager acknowledges ("got it, spawning now"), then the spawn call itself returns
  // quickly — too quickly on its own to reach even the shifted post-acknowledgment gap.
  h.call('bb_spawn_thread',{title:'demo'});
  h.session.emit('audio',speech(32*300)); // ~300ms of spoken acknowledgment
  tickBy(1000);
  await h.answer('bb_spawn_thread',{thread:{id:'thr_demo'}});
  assert.equal(h.cues.length,0,'the spawn call alone is too short to cue, as before the fix');
  // Immediately after, the manager waits on the spawned agent (no further speech in between).
  // That wait alone runs long enough that a cue must fire — the acknowledgment must not have
  // reset an indefinite suppression.
  h.call('bb_tell_thread',{threadId:'thr_demo'});
  tickBy(12000);
  assert.ok(h.cues.length>0,'the combined wait produced a cue even though the acknowledgment happened first');
  await h.answer('bb_tell_thread',{});
}));

test('a real gap with something heard in between does start a fresh wait, capped independently',withClock(async()=>{
  const h=harness({profile:'steady'});
  h.call('bb_search',{query:'x'});
  tickBy(2500);
  await h.answer('bb_search',{});
  assert.equal(h.cues.length,1,'first wait produced its ack cue');
  h.session.emit('transcript',{speaker:'assistant',text:'found it, one more check'});
  tickBy(50);
  h.call('bb_search',{query:'y'});
  tickBy(3000); // the transcript's playback tail pushes the fresh wait's own ack out a bit further
  assert.equal(h.cues.length,2,'a genuine turn boundary starts a fresh, independently-capped wait');
  await h.answer('bb_search',{});
}));

test('no cue while the assistant is speaking or the user is talking',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.call('bb_search',{query:'x'});
  for(let i=0;i<10;i++){h.session.emit('transcript',{speaker:'you',text:'and also'});tickBy(1000);}
  assert.equal(h.cues.length,0,'the user talking is not silence');
  for(let i=0;i<5;i++){h.session.emit('audio',speech(32000));tickBy(1000);}
  assert.equal(h.cues.length,0,'the assistant talking is not silence');
  // Last chunk queued at 14 s plays until 15 s (the playback clock), then 6 s of silence.
  tickBy(5900);
  assert.equal(h.cues.length,0);
  tickBy(100);
  assert.equal(h.cues.length,1);
  assert.equal(h.cues[0].at,21000);
}));

test('Quiet holds the voice; the panel still gets a line',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.session.mute(true);
  h.call('bb_spawn_thread',{title:'x'});
  tickBy(30000);
  assert.equal(h.commentary().length,0,'nothing is appended to the voice model while muted');
  assert.ok(h.cues.length>0);
  assert.ok(h.cues.every(c=>c.spoken===false&&c.suppressed==='quiet'&&c.phrase===null));
  assert.match(h.cues[0].text,/not confirmed yet/);
}));

test('review mode holds the voice too',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.session.reviewMode(true,{});
  h.call('bb_search',{query:'x'});
  h.call('bb_review_note',{text:'x'});
  tickBy(30000);
  assert.equal(h.commentary().length,0);
  assert.ok(h.cues.every(c=>c.spoken===false&&c.suppressed==='review'));
  h.session.reviewMode(false);
}));

test('review tools themselves never produce a cue',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.call('bb_review_note',{text:'x'});
  tickBy(30000);
  assert.equal(h.cues.length,0);
}));

test('a closed session stops cueing',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.call('bb_search',{query:'x'});
  h.session.close();
  tickBy(30000);
  assert.equal(h.commentary().length,0);
}));

test('wording names the actual state: lookup, dispatch, agent working, approval',withClock(async()=>{
  const h=harness({profile:'steady'});
  // Learn about two threads the way the backend does: by reading them first.
  h.call('bb_read_thread',{threadId:'thr_busy'});
  await h.answer('bb_read_thread',{thread:{id:'thr_busy',status:'active',hasPendingInteraction:false}});
  h.call('bb_search',{query:'contracts'});
  await h.answer('bb_search',{active:{results:[{thread:{id:'thr_blocked',status:'idle',hasPendingInteraction:true}}]}});
  assert.deepEqual(h.cues,[]);
  const kinds=[];
  for(const [name,args] of [['bb_search',{query:'x'}],['bb_spawn_thread',{title:'x'}],['bb_tell_thread',{threadId:'thr_busy'}],
    ['bb_tell_thread',{threadId:'thr_blocked'}],['bb_tell_thread',{threadId:'thr_new'}],['bb_stop_thread',{threadId:'thr_busy'}]]){
    h.call(name,args);tickBy(3000);
    kinds.push(h.cues.at(-1).kind);
    await h.answer(name,{});
    // A real turn boundary (something actually heard) between actions, so each one below is its
    // own fresh wait rather than a continuation of the last — see the continuity test for the
    // no-turn-boundary case.
    tickBy(50);
    h.session.emit('transcript',{speaker:'assistant',text:'ok'});
  }
  assert.deepEqual(kinds,['lookup','dispatch','agent','approval','relay','stopping']);
  const [lookup,dispatch,agent,approval,relay]=h.commentary().map(e=>e.content);
  assert.match(lookup,/BB lookup you started is still running/);
  assert.match(dispatch,/not been confirmed as started yet/);
  assert.match(agent,/still busy on its task; delivery is not confirmed yet/);
  assert.match(approval,/blocked on a BB approval that only the user can give/);
  assert.match(approval,/the approval is still the user.s to give; you cannot answer it/);
  assert.match(relay,/not been confirmed as delivered yet/);
  assert.deepEqual(h.cues.map(c=>c.category),['lookup','dispatch','agent','approval','dispatch','dispatch']);
}));

test('with several calls pending, the cue names the one that matters most to the user',withClock(async()=>{
  const h=harness({profile:'steady'});
  h.call('bb_search',{query:'x'});
  await h.answer('bb_search',{threads:[{id:'thr_blocked',status:'idle',hasPendingInteraction:true}]});
  h.call('bb_search',{query:'y'});
  h.call('bb_tell_thread',{threadId:'thr_blocked'});
  tickBy(3000);
  assert.equal(h.cues[0].kind,'approval');
  await h.answer('bb_tell_thread',{});
  tickBy(9000);
  assert.equal(h.cues[1].kind,'lookup','the remaining lookup keeps the wait going');
}));

test('never a completion claim, never a listening noise, and always under the append limit',()=>{
  for(const [kind,[acks,progress]] of Object.entries(CUE_PHRASES)){
    assert.ok(VISUAL[kind],`${kind} has a panel line`);
    assert.doesNotMatch(VISUAL[kind],COMPLETION);
    for(const phrase of [...acks,...progress]){
      assert.doesNotMatch(phrase,COMPLETION,`"${phrase}" implies completion`);
      assert.doesNotMatch(phrase,/\b(mm+|uh-huh|hmm+|mhm)\b/i);
      for(const stage of ['ack','progress']){
        const text=cueText({kind,stage,seconds:99,phrase,avoid:[...acks,...progress].slice(0,3)});
        assert.ok(text.length<1800,`${kind}/${stage} is ${text.length} characters`);
        assert.match(text,/Do not say or imply that anything is done, found, sent, started or fixed/);
        assert.match(text,/skip this/);
      }
    }
  }
});

test('consecutive cues vary their example wording',withClock(async()=>{
  const h=harness({profile:'chatty'});
  h.call('bb_search',{query:'x'});
  tickBy(60000);
  const phrases=h.cues.map(c=>c.phrase);
  for(let i=1;i<phrases.length;i++)assert.notEqual(phrases[i],phrases[i-1]);
  assert.equal(new Set(phrases.slice(1,4)).size,3,'the progress bank is used up before any repeats');
  assert.match(h.commentary()[2].content,/do not reuse/);
}));

test('cueKind reads tool names and known thread state only',()=>{
  const known=new Map([['thr_a',{running:true,blocked:false}],['thr_b',{running:false,blocked:true}]]);
  assert.equal(cueKind('bb_overview',{},known),'lookup');
  assert.equal(cueKind('bb_view_screen',{},known),'screen');
  assert.equal(cueKind('bb_focus_thread',{threadId:'thr_a'},known),'focus');
  assert.equal(cueKind('bb_tell_thread',{threadId:'thr_a'},known),'agent');
  assert.equal(cueKind('bb_tell_thread',{threadId:'thr_b'},known),'approval');
  assert.equal(cueKind('bb_stop_thread',{threadId:'thr_b'},known),'approval');
  assert.equal(cueKind('bb_review_end',{},known),null);
});

// User feedback, 2026-09-27: "about four to five seconds of silence" before a dispatch produced no cue,
// because nothing ran until a tool call existed. The backend's own thinking now counts.
function thinking(h,delegation='dT'){
  h.session.handle({type:'response.event',delegation_id:delegation,event:{type:'response.created',response:{id:`r_${delegation}`}}});
  return {
    tool:(name,args={},id=`c_${delegation}`)=>h.session.handle({type:'response.event',delegation_id:delegation,event:{type:'response.output_item.done',
      item:{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}}}),
    finish:(withCalls=false)=>h.session.handle({type:'response.event',delegation_id:delegation,event:{type:'response.completed',response:{id:`r_${delegation}`,output:withCalls?[{}]:[]}}}),
  };
}
function earconHarness(profile='subtle'){
  const h=harness({profile:'off'});
  const sounds=[];
  const tracker=attachCues(h.session,{profile,onCue:cue=>h.cues.push({...cue,at:Date.now()}),onEarcon:s=>sounds.push({...s,at:Date.now()}),random:()=>0});
  return {...h,tracker,sounds};
}

test('the reported case: 5 s of backend thinking before a dispatch starts the sound at 2.5 s, then one spoken check-in at 8 s',withClock(async()=>{
  const h=earconHarness('subtle');
  const turn=thinking(h);
  tickBy(2400);
  assert.equal(h.sounds.length,0,'nothing before 2.5 s');
  tickBy(200);
  assert.deepEqual(h.sounds.map(s=>[s.on,s.at,s.category]),[[true,2500,'thinking']],'the sound starts at 2.5 s while the backend is still thinking');
  tickBy(2400);
  turn.tool('bb_spawn_thread',{title:'long-horizon sample'});
  assert.equal(h.sounds.length,1,'no flicker when the tool call appears');
  tickBy(3000);
  assert.equal(h.cues.length,1,'one spoken check-in');
  assert.equal(h.cues[0].at,8000);
  assert.equal(h.cues[0].stage,'progress','subtle has no spoken acknowledgement; the sound is the acknowledgement');
  assert.match(h.commentary().at(-1).content,/not been confirmed as started yet/);
  tickBy(30000);
  assert.equal(h.cues.length,1,'subtle speaks once, then only the sound continues');
  assert.equal(h.sounds.filter(s=>s.on).length,1);
}));

test('thinking alone names itself honestly and never claims a lookup or a send',withClock(async()=>{
  const h=earconHarness('subtle');
  thinking(h);
  tickBy(9000);
  assert.equal(h.cues[0].kind,'thinking');
  const said=h.commentary().at(-1).content;
  assert.match(said,/still working out the answer or the next step; nothing has been looked up, sent or started yet/);
  assert.doesNotMatch(said,/BB lookup you started/);
}));

test('the sound stops the moment anything is heard, and resumes 2.5 s after speech if work is still pending',withClock(async()=>{
  const h=earconHarness('subtle');
  thinking(h);
  tickBy(3000);
  assert.equal(h.sounds.at(-1).on,true);
  h.session.emit('audio',speech(32*1000)); // one second of the manager speaking
  assert.deepEqual([h.sounds.at(-1).on,h.sounds.at(-1).reason],[false,'speech']);
  tickBy(3400);
  assert.equal(h.sounds.at(-1).on,false,'still inside 2.5 s of silence after the speech ended');
  tickBy(200);
  assert.equal(h.sounds.at(-1).on,true,'work is still pending, so the sound comes back');
  h.session.emit('transcript',{speaker:'you',text:'wait'});
  assert.deepEqual([h.sounds.at(-1).on,h.sounds.at(-1).reason],[false,'speech'],'the user talking stops it too');
}));

test('a quick answer never plays the sound; a finished turn stops it',withClock(async()=>{
  const h=earconHarness('subtle');
  const quick=thinking(h,'dQ');
  tickBy(1500);
  quick.finish();
  tickBy(20000);
  assert.equal(h.sounds.length,0,'answered inside 2.5 s: silence was never long enough');
  const slow=thinking(h,'dS');
  tickBy(3000);
  assert.equal(h.sounds.at(-1).on,true);
  slow.finish();
  assert.equal(h.sounds.at(-1).on,true,'a short grace period before stopping');
  tickBy(500);
  assert.deepEqual([h.sounds.at(-1).on,h.sounds.at(-1).reason],[false,'idle']);
}));

test('no hiccup at the hand-over between a finished tool and the backend thinking again',withClock(async()=>{
  const h=earconHarness('subtle');
  const turn=thinking(h,'dH');
  tickBy(3000);
  turn.tool('bb_search',{query:'x'});
  await h.answer('bb_search',{});
  mock.timers.tick(150);
  thinking(h,'dH2'); // the backend's next response, ~0.15 s later, exactly as measured live
  tickBy(3000);
  assert.deepEqual(h.sounds.map(s=>s.on),[true],'the sound played straight through; no off/on flicker');
}));

test('no sound in Quiet or review mode, or after the session closes',withClock(async()=>{
  const q=earconHarness('subtle');
  q.session.mute(true);
  thinking(q);tickBy(20000);
  assert.equal(q.sounds.filter(s=>s.on).length,0,'Quiet');
  const r=earconHarness('subtle');
  r.session.reviewMode(true,{});
  thinking(r);tickBy(20000);
  assert.equal(r.sounds.filter(s=>s.on).length,0,'review');
  r.session.reviewMode(false);
  const c=earconHarness('subtle');
  thinking(c);tickBy(3000);
  assert.equal(c.sounds.at(-1).on,true);
  c.session.close();
  assert.equal(c.sounds.at(-1).on,false,'close stops it');
  tickBy(20000);
  assert.equal(c.sounds.filter(s=>s.on).length,1);
}));

test('steady and chatty keep their spoken behaviour and play no sound',withClock(async()=>{
  for(const profile of ['steady','chatty']){
    const h=earconHarness(profile);
    thinking(h);tickBy(20000);
    assert.equal(h.sounds.length,0,profile);
    assert.equal(h.cues[0].stage,'ack',profile);
  }
}));

test('the real-session shape: GPT-Live streams silent frames the whole time, and they do not block cues or the sound',withClock(async()=>{
  const h=earconHarness('subtle');
  thinking(h);
  // 32 KB/s of digital silence, exactly as measured on a live session (peak amplitude 0).
  for(let ms=0;ms<9000;ms+=100){h.session.emit('audio',Buffer.alloc(3200));mock.timers.tick(100);}
  assert.equal(h.sounds.at(-1)?.on,true,'the sound started although silent frames kept arriving');
  assert.equal(h.sounds[0].at,2500);
  assert.equal(h.cues.length,1,'the spoken check-in fired at 8 s');
  assert.equal(h.cues[0].at,8000);
}));
