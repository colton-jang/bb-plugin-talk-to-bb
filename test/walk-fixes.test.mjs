// Created: 2026-09-26. Regressions from walk-mode use: an opener that named a thread it had
// never read, and requests that were recorded only where the user could not see them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContinuity, resumeBriefing } from '../reliability.mjs';
import { createManager, UserRequests, profiles } from '../bb-manager.mjs';
import { createInbox } from '../manager-inbox.mjs';
import { config } from '../live-session.mjs';

const AT=new Date('2026-09-26T19:00:00Z');
const commitment={key:'action:s0:c',id:'c1',kind:'bb_note_commitment',status:'open',
  summary:'Look into the Sound Sounds opener',at:'2026-09-26T18:00:00.000Z'};

// ---- Problem 1: the opener may only say what it has verified in this session ----

test('a call that simply ended leaves nothing to open with: its last words are not injected',()=>{
  const record=buildContinuity({sessionId:'s1',reason:'ended',context:{threadId:'thr_a',projectId:null},
    utterances:[{id:1,text:'Sound Sounds'}],receipts:[],at:AT});
  assert.equal(resumeBriefing(record),null,'no forced opener built from raw last words');
});

test('the last words of an ordinary call never reach the prompt, even when something else is open',()=>{
  const record=buildContinuity({sessionId:'s1',reason:'ended',context:{threadId:'thr_a',projectId:null},
    utterances:[{id:1,text:'Sound Sounds'}],receipts:[commitment],at:AT});
  const briefing=resumeBriefing(record);
  assert.ok(briefing);
  assert.doesNotMatch(briefing,/Sound Sounds"/,'boundary utterance is not quoted');
  assert.doesNotMatch(briefing,/The last thing the user said/);
  assert.doesNotMatch(briefing,/naming, in one sentence, what was left unresolved/,'no instruction to name items');
  assert.match(briefing,/not a thread/i,'recorded text is labelled as not naming a thread');
  assert.match(briefing,/only by count/i,'opener is limited to counts');
  assert.match(briefing,/"Look into the Sound Sounds opener"/,'commitment text is quoted verbatim, delimited');
});

test('transcription noise is not carried as an unfinished request',()=>{
  const noise=buildContinuity({sessionId:'s1',reason:'time-limit',utterances:[{id:1,text:'[pant'}],receipts:[],at:AT});
  assert.equal(noise.unfinishedRequest,null);
  assert.equal(resumeBriefing(noise),null);
  const record=buildContinuity({sessionId:'s1',reason:'ended',utterances:[{id:1,text:'real words here'},{id:2,text:'[pant'}],receipts:[],at:AT});
  assert.deepEqual(record.recentUtterances.map(u=>u.text),['real words here'],'the breath is dropped, the words kept as history');
  // A finished request followed by a breath was not cut off; it must not be promoted to one.
  const cut=buildContinuity({sessionId:'s1',reason:'time-limit',utterances:[{id:1,text:'send an agent to fix the opener'},{id:2,text:'[pant'}],receipts:[],at:AT});
  assert.equal(cut.unfinishedRequest,null);
});

test('a genuinely cut-off request is labelled as raw, possibly mis-heard speech, not a name',()=>{
  const record=buildContinuity({sessionId:'s1',reason:'time-limit',utterances:[{id:1,text:'move the Thursday block to'}],receipts:[],at:AT});
  const briefing=resumeBriefing(record);
  assert.match(briefing,/"move the Thursday block to"/);
  assert.match(briefing,/speech-to-text/);
  assert.match(briefing,/not a thread/i);
});

test('the UI context is presented as ids whose titles are unknown until read',()=>{
  const c=config({threadId:'thr_a',projectId:'proj_a'});
  assert.match(c.instructions,/title.*unknown until/i);
});

// ---- Problem 2: walk-mode notes and failures reach the manager thread ----

function fixture({cliFails=()=>false,sdk=async()=>({ok:true,delivery:'sent'}),manager='thr_mgr'}={}){
  const map=new Map(),calls=[],sdkCalls=[],requests=new UserRequests();
  const store={get:async k=>map.get(k),set:async(k,v)=>{map.set(k,structuredClone(v));},list:async()=>[...map.keys()]};
  const cli=async args=>{
    calls.push(args);
    if(cliFails(args))throw Object.assign(new Error('spawn /usr/bin/env ENOENT'),{code:'ENOENT'});
    if(args[0]==='environment')return {id:'env_a',projectId:'proj_a',status:'ready',hostId:'host_a',isGitRepo:true};
    if(args[0]==='provider')return [{id:profiles.general.model}];
    if(args[1]==='show')return {thread:{id:args[2],title:'Source thread',status:'idle'}};
    if(args[1]==='spawn')return {thread:{id:'thr_new'},delivery:'sent'};
    if(args[1]==='tell')return {delivery:'sent'};
    return {};
  };
  const inbox=createInbox({threadId:manager,cli,send:async a=>{sdkCalls.push(a);return sdk(a);}});
  const make=()=>createManager({cli,store,requests,sessionId:'s1',originThreadId:null,focus:async()=>{},inbox});
  const tells=()=>calls.filter(c=>c[1]==='tell'&&c[2]==='thr_mgr');
  return {map,calls,sdkCalls,requests,make,tells};
}
const spawn={projectId:'proj_a',environmentId:'env_a',parentThreadId:null,title:'Fix the opener',brief:'Investigate the opener and fix it properly please.',profile:'general',isolatedWorktree:false,request:'send an agent to fix it'};

test('a recorded note is delivered to the manager thread and the voice is told where it went',async()=>{
  const f=fixture();f.requests.append('write this down: fix the opener',0,true);
  const result=await f.make()('bb_note_commitment',{text:'Fix the opener hallucination',dueDate:null,request:'write this down: fix the opener'});
  assert.equal(f.tells().length,1);
  const message=f.tells()[0][3];
  assert.match(message,/Fix the opener hallucination/);
  assert.match(message,/write this down: fix the opener/,'verbatim words included');
  assert.deepEqual(f.tells()[0].slice(4),['--mode','queue','--json']);
  assert.equal(result.receipt.routedTo.status,'sent');
  assert.equal(result.receipt.routedTo.threadId,'thr_mgr');
  assert.match(result.note,/manager thread/);
  assert.equal(f.map.get(result.receipt.key).routedTo.status,'sent','the durable receipt records the delivery');
});

test('when the bb CLI itself is broken, the note still arrives through the in-process SDK',async()=>{
  const f=fixture({cliFails:()=>true});f.requests.append('note that please',0,true);
  const result=await f.make()('bb_note_commitment',{text:'Remember the Notion notes',dueDate:null,request:'note that please'});
  assert.equal(f.sdkCalls.length,1);
  assert.equal(f.sdkCalls[0].threadId,'thr_mgr');
  assert.match(f.sdkCalls[0].input[0].text,/Remember the Notion notes/);
  assert.equal(result.receipt.routedTo.status,'sent');
  assert.equal(result.receipt.routedTo.via,'sdk');
});

test('a note that cannot reach the manager thread is reported as not delivered',async()=>{
  const f=fixture({cliFails:()=>true,sdk:async()=>{throw new Error('down');}});f.requests.append('note that please',0,true);
  const result=await f.make()('bb_note_commitment',{text:'Remember the Notion notes',dueDate:null,request:'note that please'});
  assert.equal(result.receipt.routedTo.status,'failed');
  assert.match(result.note,/NOT/);
  assert.equal(result.receipt.status,'open','the note itself is still recorded');
});

test('with no manager thread configured nothing is sent and the note says where it lives',async()=>{
  const f=fixture({manager:''});f.requests.append('note that please',0,true);
  const result=await f.make()('bb_note_commitment',{text:'Remember the Notion notes',dueDate:null,request:'note that please'});
  assert.equal(f.calls.filter(c=>c[1]==='tell').length,0);
  assert.equal(f.sdkCalls.length,0);
  assert.match(result.note,/only inside Talk to BB/);
});

test('successful routine actions send nothing to the manager thread',async()=>{
  const f=fixture();f.requests.append('send an agent to fix it',0,true);
  const result=await f.make()('bb_spawn_thread',spawn);
  assert.equal(result.receipt.status,'started');
  assert.equal(f.tells().length,0);
  assert.equal(f.sdkCalls.length,0);
});

test('an infrastructure failure before dispatch is reported to the manager thread and to the voice',async()=>{
  // The 2026-09-26 failure: the CLI could not start at all, so nothing was dispatched.
  const f=fixture({cliFails:args=>args[0]==='environment'||(args[1]==='tell'&&args[2]==='thr_mgr')});
  f.requests.append('send an agent to fix it',0,true);
  await assert.rejects(f.make()('bb_spawn_thread',spawn),e=>e.name==='ActionError'&&/manager thread/.test(e.message));
  assert.equal(f.sdkCalls.length,1,'the CLI is down, so the report goes through the SDK');
  assert.match(f.sdkCalls[0].input[0].text,/could not/i);
  assert.match(f.sdkCalls[0].input[0].text,/send an agent to fix it/);
});

test('an unconfirmed dispatch is reported once, with a warning it may have gone through',async()=>{
  const f=fixture({cliFails:args=>args[1]==='spawn'});f.requests.append('send an agent to fix it',0,true);
  const manage=f.make();
  const result=await manage('bb_spawn_thread',spawn);
  assert.equal(result.receipt.status,'uncertain');
  assert.equal(f.tells().length,1);
  assert.match(f.tells()[0][3],/may or may not/i);
  assert.equal(result.reportedTo.status,'sent');
  await manage('bb_spawn_thread',spawn);
  assert.equal(f.tells().length,1,'a reused receipt is not reported again');
});

test('a validation refusal the voice can correct is not forwarded',async()=>{
  const f=fixture();f.requests.append('send an agent to fix it',0,true);
  await assert.rejects(f.make()('bb_spawn_thread',{...spawn,environmentId:'env_b',projectId:'proj_b'}),/ready environment/);
  assert.equal(f.tells().length,0);
  assert.equal(f.sdkCalls.length,0);
});
