// Created: 2026-09-15. Follow-through regressions: local dates, reconciliation, quiet, resume.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { timeContext, timeBriefing, resolveRelativeDate, correlateWorkerEvent, announcementText, batchAnnouncementText,
  buildContinuity, saveContinuity, loadContinuity, resumeBriefing, resumeSummary, openReviewFor } from '../reliability.mjs';
import { createManager, UserRequests, workerBrief, reconcileReceipt, recentReceipts, profiles } from '../bb-manager.mjs';
import { TalkSession, backendInstructions, config } from '../live-session.mjs';
import { NotificationGate } from '../review-notes.mjs';

// The reported failure: an evening in a zone well behind UTC (20:04 on September 15 in Anchorage) is already September 16 in UTC.
const EVENING_BEHIND_UTC=new Date('2026-09-16T04:04:00Z');
function store(){
  const map=new Map();
  return { map, get:async key=>map.get(key), set:async(key,value)=>{map.set(key,structuredClone(value));},
    delete:async key=>{map.delete(key);}, list:async(prefix='')=>[...map.keys()].filter(k=>k.startsWith(prefix)) };
}
function fixture({fail=false,threads=[]}={}){
  const calls=[],receipts=[],requests=new UserRequests(),kv=store();
  const cli=async args=>{
    calls.push(args);
    if(args[0]==='environment')return {id:'env_a',projectId:'proj_a',status:'ready',hostId:'host_a',isGitRepo:true,defaultBranch:'main'};
    if(args[0]==='provider')return [{id:profiles.general.model}];
    if(args[1]==='list')return threads;
    if(args[1]==='queue')return [];
    if(args[1]==='show')return {thread:{id:args[2],title:'Source thread',status:'idle',hasPendingInteraction:args[2]==='thr_blocked'}};
    if(args[1]==='spawn'){ if(fail)throw new Error('timeout'); return {thread:{id:'thr_new'},delivery:'sent'}; }
    if(args[1]==='tell')return {delivery:'sent'};
    return {};
  };
  const make=(sessionId='session_1')=>createManager({cli,store:kv,requests,sessionId,originThreadId:'thr_parent',
    focus:async()=>{},onReceipt:r=>receipts.push(r),now:()=>EVENING_BEHIND_UTC,timeZone:'America/Anchorage'});
  return {kv,calls,requests,make,receipts};
}
const spawn={projectId:'proj_a',environmentId:'env_a',parentThreadId:null,title:'Move the Thursday block',
  brief:'Draft the calendar change for review. Do not send anything.',profile:'general',isolatedWorktree:false,
  request:'have an agent move my calendar block tomorrow to seven thirty'};
const mutating=args=>args.filter(c=>['spawn','tell','stop'].includes(c[1])).length;

test('an evening behind UTC resolves tomorrow to the local next day, not the UTC date already in progress',()=>{
  const time=timeContext(EVENING_BEHIND_UTC,'America/Anchorage');
  assert.equal(time.today,'2026-09-15');
  assert.equal(time.tomorrow,'2026-09-16');
  assert.equal(time.utcDate,'2026-09-16');
  assert.equal(time.utcDateDiffers,true);
  assert.equal(resolveRelativeDate('tomorrow',time),'2026-09-16');
  assert.equal(resolveRelativeDate('thursday',time),'2026-09-17');
  const briefing=timeBriefing(time);
  assert.match(briefing,/tomorrow=2026-09-16/);
  assert.match(briefing,/UTC calendar date is already 2026-09-16; it is NOT the user's date/);
  assert.doesNotMatch(briefing,/tomorrow=2026-09-17/);
  for(const text of [backendInstructions({threadId:null,projectId:null},{time}),config({},{time}).instructions])
    assert.match(text,/2026-09-16/);
  assert.match(workerBrief(spawn,{time}),/tomorrow=2026-09-16/);
});

test('an unresolved timezone falls back to UTC instead of throwing mid-session',()=>{
  const time=timeContext(EVENING_BEHIND_UTC,'Not/AZone');
  assert.equal(time.timeZone,'UTC');
  assert.equal(time.today,'2026-09-16');
});

test('an uncertain spawn is reconciled by reading only, and never dispatched twice',async()=>{
  const f=fixture({fail:true,threads:[
    {id:'thr_found',title:'Move the Thursday block',projectId:'proj_a',status:'idle',
      createdAt:EVENING_BEHIND_UTC.getTime()+5000,updatedAt:EVENING_BEHIND_UTC.getTime()+5000},
    {id:'thr_waiting',title:'Contracts app',projectId:'proj_b',status:'idle',hasPendingInteraction:true,
      createdAt:1,updatedAt:EVENING_BEHIND_UTC.getTime()}]});
  f.requests.append(spawn.request,0,true);
  const first=await f.make()('bb_spawn_thread',spawn);
  assert.equal(first.receipt.status,'uncertain');
  assert.equal(first.receipt.projectId,'proj_a');
  const dispatches=mutating(f.calls);
  const outstanding=await f.make()('bb_outstanding',{});
  assert.equal(mutating(f.calls),dispatches,'reconciliation must not dispatch anything');
  const [found]=outstanding.unconfirmedDispatches;
  assert.equal(found.finding,'probably-created');
  assert.equal(found.candidates[0].id,'thr_found');
  assert.match(found.retry,/explicit go-ahead/);
  // An approval waiting on the user is reported as the user's, in its own bucket, not as manager work.
  assert.deepEqual(outstanding.pendingInteractions.threads.map(t=>t.id),['thr_waiting']);
  assert.match(outstanding.pendingInteractions.note,/Only the user can answer these/);
  assert.match(outstanding.coverage,/Three separate things/);
  assert.match(outstanding.coverage,/never conclude from this that everything else is clear/);
  assert.equal(outstanding.time.tomorrow,'2026-09-16');
});

test('an uncertain spawn with no matching thread is reported as not started, not as done',async()=>{
  const f=fixture({fail:true,threads:[]});
  f.requests.append(spawn.request,0,true);
  await f.make()('bb_spawn_thread',spawn);
  const [found]=(await f.make()('bb_outstanding',{})).unconfirmedDispatches;
  assert.equal(found.finding,'no-matching-thread');
  assert.match(found.detail,/probably never started/);
});

test('a session boundary does not turn one instruction into two mutations',async()=>{
  const f=fixture();
  f.requests.append(spawn.request,0,true);
  const first=await f.make('session_1')('bb_spawn_thread',spawn);
  assert.equal(first.receipt.status,'started');
  const resumed=await f.make('session_2')('bb_spawn_thread',spawn);
  assert.equal(resumed.reused,true);
  assert.equal(resumed.fromEarlierSession,true);
  assert.equal(resumed.receipt.id,first.receipt.id);
  assert.match(resumed.warning,/already dispatched/);
  assert.equal(f.calls.filter(c=>c[1]==='spawn').length,1);
});

test('an instruction interrupted before its result is not re-sent by the next session',async()=>{
  const f=fixture({fail:true});
  const request='tell that agent to change the invite to an hour';
  f.requests.append(request,0,true);
  const cut=await f.make('session_1')('bb_tell_thread',{threadId:'thr_a',mode:'steer',
    message:'Change the invite to one hour. I will add the video link myself.',request});
  assert.equal(cut.receipt.status,'sent');
  const again=await f.make('session_2')('bb_tell_thread',{threadId:'thr_a',mode:'steer',
    message:'Change the invite to one hour. I will add the video link myself.',request});
  assert.equal(again.reused,true);
  assert.equal(f.calls.filter(c=>c[1]==='tell').length,1);
});

test('a commitment is durable, does no work, and closes only when asked',async()=>{
  const f=fixture();
  f.requests.append('remember that I still owe Sam the budget number',0,true);
  const recorded=await f.make()('bb_note_commitment',{text:'Send Sam the budget number',dueDate:'2026-09-16',
    request:'remember that I still owe Sam the budget number'});
  assert.equal(recorded.receipt.status,'open');
  assert.match(recorded.note,/No agent was assigned/);
  assert.equal(mutating(f.calls),0);
  const open=await f.make()('bb_outstanding',{});
  assert.deepEqual(open.commitments.map(c=>c.text),['Send Sam the budget number']);
  f.requests.append('that one is handled now',5000,true);
  await f.make()('bb_close_commitment',{commitmentId:recorded.receipt.id,request:'that one is handled now'});
  assert.deepEqual((await f.make()('bb_outstanding',{})).commitments,[]);
});

test('a relayed instruction cannot answer an approval that belongs to the user',async()=>{
  const f=fixture();
  const request='tell the staffing agent to use the September numbers';
  f.requests.append(request,0,true);
  const result=await f.make()('bb_tell_thread',{threadId:'thr_blocked',mode:'queue',
    message:'Use the September numbers.',request});
  assert.match(result.approval,/only the user can answer/);
  assert.equal(result.receipt.blockedOnApproval,true);
  const answering=Object.keys(await import('../bb-manager.mjs').then(m=>m.actionSchemas))
    .filter(name=>/interaction|approve|permission|answer/i.test(name));
  assert.deepEqual(answering,[],'no tool may answer a BB approval');
});

test('one idle event updates the newest receipt for that thread and re-announces nothing',()=>{
  const receipts=[
    {key:'action:s:1',id:'r1',kind:'bb_spawn_thread',threadId:'thr_w',title:'Staffing sweep',at:'2026-09-15T01:00:00.000Z',status:'started',summary:'Old assignment'},
    {key:'action:s:2',id:'r2',kind:'bb_tell_thread',threadId:'thr_w',title:'Staffing sweep',at:'2026-09-15T03:00:00.000Z',status:'sent',summary:'Newest instruction'},
    {key:'action:s:3',id:'r3',kind:'bb_spawn_thread',threadId:'thr_other',title:'Other work',at:'2026-09-15T02:00:00.000Z',status:'started'},
  ];
  const at=Date.parse('2026-09-15T04:00:00.000Z');
  const thread={id:'thr_w',title:'Staffing sweep',updatedAt:1789000000000};
  const first=correlateWorkerEvent({receipts,event:'thread.idle',thread,lastAssistantText:'  Wrote the draft\n\n',at});
  assert.deepEqual(first.updates.map(u=>u.id),['r2']);
  assert.equal(first.updates[0].workerState,'replied');
  assert.equal(first.updates[0].workerSnippet,'Wrote the draft');
  assert.equal(first.announcement.otherReceipts,1);
  assert.match(announcementText(first.announcement),/does not establish that the task succeeded/);
  assert.match(announcementText(first.announcement),/unchanged by this update/);
  const applied=receipts.map(r=>r.id==='r2'?first.updates[0]:r);
  assert.deepEqual(correlateWorkerEvent({receipts:applied,event:'thread.idle',thread,at}),{updates:[],announcement:null});
  const later=correlateWorkerEvent({receipts:applied,event:'thread.idle',thread:{...thread,updatedAt:1789000009999},at});
  assert.deepEqual(later.updates.map(u=>u.id),['r2']);
  assert.deepEqual(correlateWorkerEvent({receipts:applied,event:'thread.idle',thread:{id:'thr_unrelated'},at}),{updates:[],announcement:null});
  const future=correlateWorkerEvent({receipts,event:'thread.idle',thread,at:Date.parse('2026-09-15T00:00:00.000Z')});
  assert.deepEqual(future.updates,[],'a dispatch made after the event is not correlated to it');
});

function mockSession(options={}){
  const sent=[];const session=new TalkSession({key:'test',query:async()=>({}),...options});
  session.socket={readyState:1,bufferedAmount:0,send:value=>sent.push(JSON.parse(value)),close(){},terminate(){}};
  return {session,sent,commentary:()=>sent.filter(e=>e.type==='session.commentary.append')};
}
const announcement={threadId:'thr_w',title:'Staffing sweep',state:'replied',snippet:'done',assignment:'sweep',otherReceipts:0};

test('worker news waits while the user asked for quiet and arrives once afterwards',()=>{
  const {session,sent,commentary}=mockSession();session.ready=true;
  session.mute(true);
  session.notifyWorker(announcement);
  session.notifyWorker({...announcement,threadId:'thr_x',title:'Contracts'});
  assert.equal(commentary().length,0,'quiet must not be interrupted');
  assert.equal(session.deferred.length,2);
  session.mute(false);
  const batched=commentary();
  assert.equal(batched.length,1,'held updates arrive together, not one interruption each');
  assert.match(batched[0].content,/2 threads/);
  assert.match(batched[0].content,/do not interrupt for them/);
  assert.equal(session.deferred.length,0);
  session.notifyWorker(announcement);
  assert.equal(commentary().length,2);
  assert.equal(sent.filter(e=>e.type==='session.instructions.append').length,2);
  session.clear();
});

test('the time cap is announced before it lands and its timers do not outlive the session',()=>{
  mock.timers.enable({apis:['setTimeout']});
  try {
    const {session,commentary}=mockSession({maxMs:1000,warnMs:[400,100]});
    const notices=[];session.on('notice',n=>notices.push(n));
    session.handle({type:'session.started'});
    assert.equal(session.warnings.length,2);
    mock.timers.tick(600);
    assert.equal(notices.length,1);
    assert.match(notices[0].text,/minute/);
    assert.match(commentary()[0].content,/what should carry over/);
    assert.match(commentary()[0].content,/bb_note_commitment/);
    mock.timers.tick(300);
    assert.equal(notices.length,2);
    mock.timers.tick(200);
    assert.equal(session.closing,true);
    assert.equal(session.reason,'time-limit');
    assert.equal(session.warnings.length,0);
    mock.timers.tick(5000);
    assert.equal(notices.length,2,'no notice may fire after the session closed');
    session.clear();
  } finally { mock.timers.reset(); }
});

test('the boundary utterance and unfinished work survive the cap and resume as history only',async()=>{
  const kv=store();
  const requests=new UserRequests();
  requests.append('move my calendar block tomorrow to seven',1000,true);
  requests.append('actually make that seven thirty and',4000,true);
  const receipts=[
    {key:'action:s1:a',id:'c1',kind:'bb_note_commitment',status:'open',summary:'Send Sam the budget number',dueDate:'2026-09-16',at:'2026-09-16T03:00:00.000Z'},
    {key:'action:s1:b',id:'d1',kind:'bb_spawn_thread',status:'uncertain',threadId:null,title:'Move the Thursday block',at:'2026-09-16T03:30:00.000Z'},
    {key:'action:s1:c',id:'d2',kind:'bb_tell_thread',status:'sent',threadId:'thr_a',title:'Other',at:'2026-09-16T03:40:00.000Z'},
  ];
  const record=buildContinuity({sessionId:'s1',reason:'time-limit',context:{threadId:'thr_a',projectId:null},
    utterances:requests.parts,receipts,at:EVENING_BEHIND_UTC,seconds:1200});
  assert.equal(record.unfinishedRequest.text,'actually make that seven thirty and');
  assert.deepEqual(record.openCommitments.map(c=>c.text),['Send Sam the budget number']);
  assert.deepEqual(record.unresolvedDispatches.map(d=>d.status),['uncertain']);
  await saveContinuity(kv,record);
  for(const n of [2,3,4,5]) await saveContinuity(kv,{...record,key:`continuity:s${n}`,sessionId:`s${n}`});
  assert.equal((await kv.list('continuity:')).length,3,'only the recent sessions are kept');
  assert.equal((await loadContinuity(kv,{now:EVENING_BEHIND_UTC.getTime()+60000,sessionId:'s5'})).sessionId,'s4','the live session never resumes itself');
  const loaded=await loadContinuity(kv,{now:EVENING_BEHIND_UTC.getTime()+60000,sessionId:'new'});
  assert.equal(loaded.sessionId,'s5');
  assert.equal(await loadContinuity(kv,{now:EVENING_BEHIND_UTC.getTime()+13*3600000,sessionId:'new'}),null,'stale context is not resumed');

  const briefing=resumeBriefing(record);
  assert.match(briefing,/HISTORY, not authorization/);
  assert.match(briefing,/seven thirty/);
  assert.match(briefing,/never re-dispatch on your own/);
  const summary=resumeSummary(record);
  assert.equal(summary.unfinished,'actually make that seven thirty and');
  assert.match(summary.note,/Nothing was resumed automatically/);

  // The resumed text is injected as thinking context and must not authorize a tool call.
  const {session,sent}=mockSession();session.ready=true;
  assert.equal(session.resume(briefing),true);
  assert.equal(sent.at(-1).type,'session.thinking.append');
  assert.equal(sent.filter(e=>e.type==='response.create').length,0,'resuming must not act');
  assert.throws(()=>session.userRequests.authorize('actually make that seven thirty and'),/not in this live conversation/);
  assert.throws(()=>session.userRequests.authorize('Send Sam the budget number'),/not in this live conversation/);
  session.clear();
});

test('a review holds worker news exactly once: un-muting mid-review does not speak it',()=>{
  const {session,commentary}=mockSession();session.ready=true;
  const gate=new NotificationGate({policy:'pause',pauseMs:10*60000,clock:()=>Date.parse('2026-09-16T04:00:00Z')});
  session.reviewGate=gate;session.reviewing=true;
  const held=[];session.on('deferred-notice',n=>held.push(n));
  session.notifyWorker(announcement);
  session.notifyWorker({...announcement,threadId:'thr_x',title:'Contracts'});
  assert.equal(commentary().length,0,'dictation is not interrupted');
  assert.equal(gate.heldCount,2);
  assert.deepEqual(held.map(h=>h.reason),['review','review']);
  assert.equal(session.deferred.length,0,'a gate-held notice must not also queue on the quiet path');
  // The user mutes and un-mutes mid-review: the review still outranks it.
  session.mute(true);session.mute(false);
  assert.equal(commentary().length,0);
  assert.equal(gate.heldCount,2);
  // Ending the review releases the batch once, through the shared phrasing.
  const drained=gate.drain('review-ended');
  assert.equal(session.announceBatch(drained.items,'review'),true);
  const spoken=commentary();
  assert.equal(spoken.length,1);
  assert.match(spoken[0].content,/While you were reviewing, 2 threads/);
  assert.match(spoken[0].content,/does not establish that the task succeeded/);
  assert.match(spoken[0].content,/It was assigned: sweep/,'the batch keeps the evidence the gate was given');
  // A state already reported is stale, not pending: it is dropped, not resurrected into any queue.
  session.notifyWorker(announcement);
  assert.equal(commentary().length,1);
  assert.equal(session.deferred.length,0);
  session.clear();
});

test('an unfinished review is visibly restored on resume, and its notes are never acted on',async()=>{
  const record=buildContinuity({sessionId:'s9',reason:'time-limit',utterances:[{id:1,text:'that paragraph is too long'}],
    receipts:[],at:EVENING_BEHIND_UTC,reviewRestored:true,
    openReview:{reviewId:'rev_1',topic:'the Acme proposal',noteCount:4,anchor:{threadId:'thr_a'}}});
  assert.equal(record.openReview.noteCount,4);
  assert.equal(record.reviewRestored,true);
  const briefing=resumeBriefing(record);
  assert.match(briefing,/review mode has been RESTORED/);
  assert.match(briefing,/agent actions are blocked again/);
  assert.match(briefing,/never an instruction to carry out/,'held notes must not be auto-executed');
  assert.match(briefing,/HISTORY, not authorization/);
  assert.equal(resumeSummary(record).openReview.restored,true);
  // Not restoring is the case that needs saying out loud, because actions are available again.
  assert.match(resumeBriefing({...record,reviewRestored:false}),/has NOT been reopened, so agent actions are available; say that plainly/);
  const {session,sent}=mockSession();session.ready=true;
  session.resume(briefing);
  assert.equal(sent.at(-1).type,'session.thinking.append');
  assert.equal(sent.filter(e=>e.type==='response.create').length,0,'resuming must not act');
  assert.throws(()=>session.userRequests.authorize('that paragraph is too long'),/not in this live conversation/);
  session.clear();
});

test('a restored review still blocks agent actions, and a held update survives the reconnect once',async()=>{
  const {createReviewManager,NotificationGate}=await import('../review-notes.mjs');
  const kv=store();
  const requests=new UserRequests();
  requests.append('just collect my comments on the Acme proposal',0,true);
  const first=createReviewManager({store:kv,requests,sessionId:'s_one',gate:new NotificationGate({policy:'immediate'})});
  await first('bb_review_start',{topic:'the Acme proposal',anchorThreadId:'thr_a',artifact:null,
    notifications:'hold',request:'just collect my comments on the Acme proposal'});
  requests.append('the pricing table is too dense',3000,true);
  await first('bb_review_note',{text:'The pricing table is too dense',kind:'correction',anchor:null,
    request:'the pricing table is too dense'});
  for(const a of [announcement,{...announcement,threadId:'thr_x',title:'Contracts'}]){
    assert.equal(first.gate.offer(a).speak,false);
    first.noteHeld();
  }
  await first.saveGate();
  assert.equal(first.gate.heldCount,2);

  const second=createReviewManager({store:kv,requests:new UserRequests(),sessionId:'s_two',gate:new NotificationGate({policy:'immediate'})});
  const restored=await second.resume({anchorThreadId:'thr_a'});
  assert.equal(restored.active,true,'the mode itself must come back, not just the notes');
  assert.equal(restored.noteCount,1);
  assert.equal(second.gate.heldCount,2,'a requested completion must not be lost to a reconnect');
  assert.throws(()=>second.guard('bb_spawn_thread',{}),/Review mode is on/);
  assert.throws(()=>second.guard('bb_tell_thread',{threadId:'thr_a'}),/not acting on them/);
  const drained=second.gate.drain('requested');
  assert.deepEqual(drained.items.map(i=>i.threadId).sort(),['thr_w','thr_x']);
  await second.saveGate();
  const third=createReviewManager({store:kv,requests:new UserRequests(),sessionId:'s_three',gate:new NotificationGate({policy:'immediate'})});
  await third.resume({anchorThreadId:'thr_a'});
  assert.equal(third.gate.heldCount,0,'an already-reported state must not be replayed');
  assert.equal(third.gate.offer(announcement).suppressed,true,'and it stays suppressed after the reconnect');
});

test('a clearly authorized multi-step apply needs one handoff, not one per step',async()=>{
  const {createReviewManager,NotificationGate}=await import('../review-notes.mjs');
  const kv=store();
  const requests=new UserRequests();
  const ask='send these notes to the staffing thread and start an agent on the pricing';
  requests.append('just collect my comments',0,true);
  const manage=createReviewManager({store:kv,requests,sessionId:'s_apply',gate:new NotificationGate()});
  await manage('bb_review_start',{topic:'the Acme proposal',anchorThreadId:'thr_a',artifact:null,
    notifications:'hold',request:'just collect my comments'});
  requests.append(ask,5000,true);
  await manage('bb_review_note',{text:'Tighten the pricing table',kind:'correction',anchor:null,request:ask});
  const handoff=await manage('bb_review_handoff',{target:'thread-and-agent',threadId:'thr_a',grants:2,request:ask});
  assert.match(handoff.permits,/2 actions/);
  assert.match(handoff.permits,/without checking back between steps/);
  assert.doesNotThrow(()=>manage.guard('bb_tell_thread',{threadId:'thr_a'}));
  assert.doesNotThrow(()=>manage.guard('bb_spawn_thread',{}));
  assert.throws(()=>manage.guard('bb_spawn_thread',{}),/Review mode is on/);
  assert.equal(manage.state().permission,null);
  await manage('bb_review_handoff',{target:'thread',threadId:'thr_a',grants:3,request:ask});
  assert.throws(()=>manage.guard('bb_spawn_thread',{}),/Review mode is on/);
  assert.throws(()=>manage.guard('bb_tell_thread',{threadId:'thr_other'}),/Review mode is on/);
  assert.equal(manage.state().permission.remaining,3,'a refused action must not spend a grant');
});


test('an open review found in storage flows into the continuity record the server writes',async()=>{
  const {createReviewManager,resumableReview,ReviewNotes}=await import('../review-notes.mjs');
  const kv=store();
  const requests=new UserRequests();
  requests.append('just collect my comments on the Acme proposal',0,true);
  const manage=createReviewManager({store:kv,requests,sessionId:'s_live',originThreadId:'thr_proposal'});
  await manage('bb_review_start',{topic:'the Acme proposal',anchorThreadId:'thr_proposal',artifact:null,
    notifications:'hold',request:'just collect my comments on the Acme proposal'});
  requests.append('the pricing table is too dense',3000,true);
  await manage('bb_review_note',{text:'The pricing table is too dense',kind:'correction',anchor:null,
    request:'the pricing table is too dense'});

  // Exactly what the server does at teardown, through the same helper.
  const found=await openReviewFor(kv,{resumableReview,ReviewNotes});
  assert.ok(found,'an unfinished review must be recoverable from storage');
  const record=buildContinuity({sessionId:'s_live',reason:'time-limit',utterances:requests.parts,
    receipts:await recentReceipts(kv),at:EVENING_BEHIND_UTC,openReview:found});
  assert.equal(record.openReview.topic,'the Acme proposal');
  assert.equal(record.openReview.noteCount,1);
  assert.equal(record.openReview.anchor?.threadId,'thr_proposal');
  assert.match(resumeBriefing(record),/unfinished review is still open on the Acme proposal with 1 note/);
  assert.match(resumeBriefing(record),/has NOT been reopened/);
  // A closed review is not offered as carried-over state.
  await manage('bb_review_end',{request:'the pricing table is too dense'});
  assert.equal(await openReviewFor(kv,{resumableReview,ReviewNotes}),null);
});

test('worker news held by a mute is carried over too, not just news held by a review',()=>{
  const {session}=mockSession();session.ready=true;
  session.mute(true);
  session.notifyWorker(announcement);
  session.notifyWorker({...announcement,threadId:'thr_x',title:'Contracts',state:'needs-input'});
  session.notifyWorker({...announcement,state:'failed'}); // same thread again: latest state wins
  assert.equal(session.deferred.length,3);
  const record=buildContinuity({sessionId:'s_mute',reason:'disconnected',utterances:[{id:1,text:'hold on'}],
    receipts:[],at:EVENING_BEHIND_UTC,heldNotices:session.deferred});
  assert.deepEqual(record.heldNotices.map(n=>n.threadId),['thr_w','thr_x']);
  assert.equal(record.heldNotices.find(n=>n.threadId==='thr_w').state,'failed','one entry per thread, latest state');
  const briefing=resumeBriefing(record);
  assert.match(briefing,/arrived while replies were muted and were never spoken/);
  assert.match(briefing,/read the thread before describing any of them/);
  assert.match(briefing,/do not repeat one the user has already heard/);
  assert.deepEqual(resumeSummary(record).heldNotices.map(n=>n.state),['failed','needs-input']);
  session.clear();
});

test('a notice that outlived its session is reported as history, never as current status',async()=>{
  const {createReviewManager,NotificationGate}=await import('../review-notes.mjs');
  const kv=store();
  const requests=new UserRequests();
  requests.append('just collect my comments',0,true);
  const first=createReviewManager({store:kv,requests,sessionId:'s_a',gate:new NotificationGate({policy:'immediate'})});
  await first('bb_review_start',{topic:'the proposal',anchorThreadId:'thr_a',artifact:null,notifications:'hold',
    request:'just collect my comments'});
  first.gate.offer(announcement);first.noteHeld();
  await first.saveGate();

  const next=createReviewManager({store:kv,requests:new UserRequests(),sessionId:'s_b',gate:new NotificationGate({policy:'immediate'})});
  await next.resume({anchorThreadId:'thr_a'});
  const restored=[...next.gate.queue.values()];
  assert.equal(restored[0].restored,true,'a notice carried across a session must be marked');
  // Both paths the model can hear it through say it is historical.
  const single=announcementText(restored[0]);
  assert.match(single,/HELD FROM A PREVIOUS SESSION/);
  assert.match(single,/read the thread or check recent actions before saying anything about its current state/);
  assert.doesNotMatch(single,/the agent has replied —/,'the present-tense phrasing must not be used for a stale notice');
  const batch=batchAnnouncementText(restored,'review');
  assert.match(batch,/held from a PREVIOUS session and are historical/);
  assert.match(batch,/do not present any of them as current/);
  // And the tool result the model reads directly carries the same caveat.
  requests.append('what have the agents been doing',9000,true);
  const result=await next('bb_review_updates',{});
  assert.equal(result.staleCount,1);
  assert.match(result.staleNote,/never report one as the current status/);
});

test('a handoff naming no thread is refused before it changes the grant or the mode',async()=>{
  const {createReviewManager,NotificationGate}=await import('../review-notes.mjs');
  const kv=store();
  const requests=new UserRequests();
  const ask='send these to the thread and start an agent';
  requests.append('just collect my comments',0,true);
  const manage=createReviewManager({store:kv,requests,sessionId:'s_v',gate:new NotificationGate()});
  await manage('bb_review_start',{topic:'the proposal',anchorThreadId:'thr_a',artifact:null,notifications:'hold',
    request:'just collect my comments'});
  requests.append(ask,4000,true);
  // A standing permission must survive a malformed handoff untouched.
  await manage('bb_review_handoff',{target:'agent',threadId:null,grants:1,request:ask});
  assert.equal(manage.state().permission.target,'agent');
  for (const target of ['thread','thread-and-agent'])
    await assert.rejects(manage('bb_review_handoff',{target,threadId:null,grants:2,request:ask}),
      /names no thread|Name the thread/,`${target} with no threadId must be refused`);
  assert.equal(manage.state().permission.target,'agent','the earlier grant must be intact');
  assert.equal(manage.state().permission.remaining,1);
  assert.equal(manage.state().active,true,'and the review must still be open');
  // The same handoff with a thread is accepted.
  const ok=await manage('bb_review_handoff',{target:'thread-and-agent',threadId:'thr_a',grants:2,request:ask});
  assert.match(ok.permits,/2 actions/);
});
