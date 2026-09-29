// Created: 2026-09-27. Configurable call length and the walk handoff at the limit.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMinutes, warningOffsets, walkLedger, ledgerText, buildHandoff, saveHandoff, claimHandoff,
  consumeHandoff, handoffBriefing, handoffSummary, PROVIDER_CEILING_MINUTES, HANDOFF_TTL_MS } from '../handoff.mjs';
import { TalkSession, config } from '../live-session.mjs';
import { sessionBriefing, WALK_GUIDANCE, CONTINUATION_GUIDANCE } from '../operating-context.mjs';

function store(){
  const map=new Map();
  return { map, get:async k=>map.get(k), set:async(k,v)=>{map.set(k,structuredClone(v));},
    delete:async k=>{map.delete(k);}, list:async(p='')=>[...map.keys()].filter(k=>k.startsWith(p)) };
}
function mockSession(options={}){
  const sent=[];const session=new TalkSession({key:'test',query:async()=>({}),...options});
  session.socket={readyState:1,bufferedAmount:0,send:v=>sent.push(JSON.parse(v)),close(){},terminate(){}};
  return {session,sent,commentary:()=>sent.filter(e=>e.type==='session.commentary.append')};
}
const WALK_START='2026-09-27T20:00:00.000Z';
const receipts=[
  {id:'old',kind:'bb_note_commitment',status:'open',at:'2026-09-27T08:00:00.000Z',summary:'Previous walk: call the dentist'},
  {id:'p1',kind:'bb_note_commitment',status:'open',at:'2026-09-27T20:05:00.000Z',summary:'Reply to the vendor after Jordan answers',dueDate:'2026-09-29'},
  {id:'p2',kind:'bb_note_commitment',status:'closed',at:'2026-09-27T20:06:00.000Z',summary:'Handled already'},
  {id:'s1',kind:'bb_tell_thread',status:'sent',at:'2026-09-27T20:07:00.000Z',title:'Operating context thread',threadId:'thr_a'},
  {id:'s2',kind:'bb_spawn_thread',status:'started',at:'2026-09-27T20:08:00.000Z',title:'Ascend proposal draft',threadId:'thr_b',workerState:'replied'},
  {id:'s3',kind:'bb_spawn_thread',status:'uncertain',at:'2026-09-27T20:09:00.000Z',title:'Never confirmed',threadId:null},
  {id:'f1',kind:'bb_focus_thread',status:'focused',at:'2026-09-27T20:10:00.000Z',title:'Just opened a thread'},
];

test('call length: default 20, configurable, clamped to 5..60', ()=>{
  assert.equal(sessionMinutes('').minutes,20);
  assert.equal(sessionMinutes(undefined).minutes,20);
  assert.equal(sessionMinutes('abc').minutes,20);
  assert.deepEqual(sessionMinutes('45'),{minutes:45,requested:45,clamped:false});
  assert.deepEqual(sessionMinutes('90'),{minutes:PROVIDER_CEILING_MINUTES,requested:90,clamped:true});
  assert.equal(sessionMinutes('2').minutes,5);
  assert.deepEqual(warningOffsets(20),[300000,60000]);
  assert.deepEqual(warningOffsets(5),[60000],'a 5-minute call only gets the 1-minute warning');
});

test('walk ledger: only this walk, only receipts, exactly parked / sent / in progress', ()=>{
  const ledger=walkLedger(receipts,{since:WALK_START});
  assert.deepEqual(ledger.parked.map(p=>p.id),['p1'],'previous walk and closed commitments are excluded');
  assert.deepEqual(ledger.sent.map(s=>s.id),['s1','s2'],'uncertain dispatches and focus are not "sent"');
  assert.deepEqual(ledger.inProgress.map(i=>i.id),['s1'],'a replied agent is no longer in progress');
  const text=ledgerText(ledger);
  assert.match(text,/^Parked: Reply to the vendor after Jordan answers \(due 2026-09-29\)\. Sent: .*In progress: /);
  assert.doesNotMatch(text,/dentist|Handled already|Never confirmed|Just opened/);
  assert.equal(ledgerText(walkLedger([],{since:WALK_START})),'Parked: none. Sent: none. In progress: none.');
});

test('handoff record carries the walk forward and nothing older', ()=>{
  const at=new Date('2026-09-27T20:55:00.000Z');
  const rec=buildHandoff({sessionId:'s-leg1',walkStartedAt:WALK_START,leg:1,reason:'handoff',at,receipts,
    utterances:[{id:1,text:'one'},{id:2,text:'two'},{id:3,text:'three'},{id:4,text:'and then the Ascend budget'}]});
  assert.equal(rec.leg,2);
  assert.equal(rec.walkId,'s-leg1');
  assert.deepEqual(rec.recentUtterances,['two','three','and then the Ascend budget']);
  assert.equal(Date.parse(rec.expiresAt)-at.getTime(),HANDOFF_TTL_MS);
  const briefing=handoffBriefing(rec);
  assert.match(briefing,/CONTINUES the user's current walk \(leg 2\)/);
  assert.match(briefing,/Do not greet and do not use the usual opener/);
  assert.match(briefing,/HISTORY, not authorization/);
  assert.match(briefing,/"and then the Ascend budget"/);
  assert.doesNotMatch(briefing,/dentist/,'no stale prior-walk content');
  const next=buildHandoff({sessionId:'s-leg2',walkId:rec.walkId,walkStartedAt:rec.walkStartedAt,leg:rec.leg,reason:'provider-expired',at});
  assert.equal(next.leg,3);assert.equal(next.walkId,'s-leg1');
  assert.match(handoffBriefing(next),/limit set by the voice service/);
  assert.deepEqual(handoffSummary(rec),{handoff:true,leg:2,parked:1,sent:2,inProgress:1,note:'Continued the same walk after a planned reconnect. Nothing was acted on automatically.'});
});

test('handoff tokens are validated, short-lived and single use; a failed reconnect can retry', async()=>{
  const kv=store();const at=new Date('2026-09-27T20:55:00.000Z');
  const rec=await saveHandoff(kv,buildHandoff({sessionId:'s1',walkStartedAt:WALK_START,reason:'handoff',at}));
  assert.equal((await claimHandoff(kv,'not-a-token')).why,'invalid');
  assert.equal((await claimHandoff(kv,'00000000-0000-0000-0000-000000000000')).why,'unknown');
  const ok=await claimHandoff(kv,rec.token,{now:at.getTime()+1000});
  assert.equal(ok.record.token,rec.token);
  assert.equal((await claimHandoff(kv,rec.token,{now:at.getTime()+2000})).why,null,'claiming alone does not spend it, so Continue walk can retry');
  await consumeHandoff(kv,rec,{now:at.getTime()+3000});
  assert.equal((await claimHandoff(kv,rec.token,{now:at.getTime()+4000})).why,'used');
  const late=await saveHandoff(kv,buildHandoff({sessionId:'s2',walkStartedAt:WALK_START,reason:'handoff',at}));
  assert.equal((await claimHandoff(kv,late.token,{now:at.getTime()+HANDOFF_TTL_MS+1})).why,'expired');
  const later=new Date(at.getTime()+2*HANDOFF_TTL_MS);
  await saveHandoff(kv,buildHandoff({sessionId:'s3',walkStartedAt:WALK_START,reason:'handoff',at:later}));
  assert.equal((await kv.list('handoff:')).length,1,'expired tokens are pruned');
});

test('handoff mode: the limit closes with reason handoff and the warning promises continuation', ()=>{
  mock.timers.enable({apis:['setTimeout']});
  try {
    const {session,commentary}=mockSession({maxMs:1000,warnMs:[400],handoffAtLimit:true});
    const notices=[];session.on('notice',n=>notices.push(n));
    session.handle({type:'session.started'});
    mock.timers.tick(700);
    assert.match(notices[0].text,/until the connection refreshes\. Your walk continues/);
    assert.equal(notices[0].handoff,true);
    assert.match(commentary()[0].content,/walk ledger \(parked, sent, in progress\).*carry across automatically/);
    assert.doesNotMatch(commentary()[0].content,/and ask what should carry over/);
    mock.timers.tick(400);
    assert.equal(session.reason,'handoff');
    session.clear();
  } finally { mock.timers.reset(); }
});

test('without handoff the old hard-limit behaviour is unchanged', ()=>{
  mock.timers.enable({apis:['setTimeout']});
  try {
    const {session}=mockSession({maxMs:1000,warnMs:[]});
    session.handle({type:'session.started'});
    mock.timers.tick(1100);
    assert.equal(session.reason,'time-limit');
    session.clear();
  } finally { mock.timers.reset(); }
});

test("a provider-side expiry is recorded as provider-expired, not a generic disconnect", ()=>{
  const {session}=mockSession();session.ready=true;
  session.handle({type:'session.closed',reason:'expired',usage:{seconds:3600}});
  assert.equal(session.reason,'provider-expired');
  assert.equal(session.seconds,3600);
  const other=mockSession().session;other.close('ended');
  other.handle({type:'session.closed',reason:'expired'});
  assert.equal(other.reason,'ended','a close we started keeps our own reason');
});

test('the model is told the real limit and the handoff behaviour', ()=>{
  const plain=config({},{limitMinutes:20}).instructions;
  assert.match(plain,/hard 20-minute limit/);
  const walk=config({},{limitMinutes:55,handoff:true}).instructions;
  assert.match(walk,/lasts up to 55 minutes/);
  assert.match(walk,/Continue walk/);
  assert.doesNotMatch(walk,/twenty-minute/i);
});

test('a continued leg skips the opener but keeps the ledger rule', ()=>{
  const text=sessionBriefing({continuation:true});
  assert.equal(text,CONTINUATION_GUIDANCE);
  assert.doesNotMatch(text,/Your current active work includes/);
  assert.match(text,/IN-CALL LEDGER/);
  assert.equal(sessionBriefing(),WALK_GUIDANCE);
});

test('the continuation append stays under the GPT-Live 500-token append limit', ()=>{
  const many=Array.from({length:40},(_,i)=>({id:`c${i}`,kind:'bb_note_commitment',status:'open',at:'2026-09-27T20:30:00.000Z',summary:`Parked item number ${i} with a fairly long description of what to do later`}));
  const rec=buildHandoff({sessionId:'s',walkStartedAt:WALK_START,reason:'handoff',receipts:many,
    utterances:[{id:1,text:'x'.repeat(2000)},{id:2,text:'y'.repeat(2000)},{id:3,text:'z'.repeat(2000)}]});
  const text=handoffBriefing(rec);
  assert.ok(text.length<=1800,`continuation append is ${text.length} chars`);
  assert.match(text,/\(\+34 more\)/);
});

test('network-drop continuation: an explicit token wins, a recent drop continues, an old one does not', async()=>{
  const { pickHandoffToken, holderIsStale, TIMING } = await import('../netdrop.mjs');
  const now=Date.parse('2026-09-27T21:00:00Z');
  assert.equal(pickHandoffToken({explicit:'tok-explicit',lastDrop:{token:'tok-drop',at:now},now}),'tok-explicit');
  assert.equal(pickHandoffToken({lastDrop:{token:'tok-drop',at:now-60000},now}),'tok-drop');
  assert.equal(pickHandoffToken({lastDrop:{token:'tok-drop',at:now-HANDOFF_TTL_MS-1},now}),null);
  assert.equal(pickHandoffToken({now}),null);
  assert.equal(holderIsStale({lastSeen:now-1000,socketClosed:false},now),false);
  assert.equal(holderIsStale({lastSeen:now-TIMING.takeoverStaleMs-1,socketClosed:false},now),true);
  assert.equal(holderIsStale({lastSeen:now,socketClosed:true},now),true);
});
