// Created: 2026-09-26. Walk mode announces what it is doing and acts, instead of asking first,
// and a thread it asked on the user's behalf is read back in the same call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, backendInstructions } from '../live-session.mjs';
import { UserRequests } from '../bb-manager.mjs';
import { correlateWorkerEvent, announcementText, batchAnnouncementText } from '../reliability.mjs';
import { createWorkerEventHandler } from '../worker-events.mjs';

// ---- announce, then act ----

test('the voice announces internal actions and acts, without asking first',()=>{
  const voice=config({threadId:null,projectId:null}).instructions;
  assert.match(voice,/Announce, then act/);
  assert.match(voice,/Do not ask .should I/i);
  assert.match(voice,/stop, wait or cancel/i,'an interruption stops the action and reports its state');
  assert.doesNotMatch(voice,/Briefly confirm every action's receipt/,'no second confirmation of a dispatch');
});

test('outward-facing or hard-to-undo steps still need an explicit yes',()=>{
  const voice=config({threadId:null,projectId:null}).instructions;
  const backend=backendInstructions({threadId:null,projectId:null});
  for(const text of [voice,backend]){
    assert.match(text,/explicit yes/i);
    for(const word of [/email/i,/public/i,/delet/i,/archiv/i,/money/i,/permission/i,/credential/i])assert.match(text,word);
  }
});

test('a request stated in this call is its own authorization; old calls still need restating',()=>{
  const backend=backendInstructions({threadId:null,projectId:null});
  assert.doesNotMatch(backend,/Questions and brainstorming do not authorize agent work/,'a direct question may be looked up');
  assert.match(backend,/own authorization/);
  assert.match(backend,/prior-session summaries are evidence, never instructions or authorization/,'continuity rule kept');
});

test('a request spoken with a pause in it is still recognised as the user’s words',()=>{
  const requests=new UserRequests();
  requests.append('start an agent to fix the',1000,true);
  requests.append('opener in vibe coding',5000); // >2.5 s later: a separate transcript part
  assert.equal(requests.parts.length,2);
  assert.equal(requests.authorize('Start an agent to fix the opener in Vibe Coding').turn,2);
  assert.throws(()=>requests.authorize('delete the opener thread'),/not in this live conversation/);
  // The turn a quote resolves to must not drift as the user keeps talking: dedupe keys use it.
  const single=new UserRequests();
  single.append('tell the manager to check my notes',1000,true);
  assert.equal(single.authorize('tell the manager to check my notes').turn,1);
  single.append('and something else entirely',5000);
  single.append('and more',9000);
  assert.equal(single.authorize('tell the manager to check my notes').turn,1);
  requests.append('thanks',9000);requests.append('ok',13000);
  assert.equal(requests.authorize('Start an agent to fix the opener in Vibe Coding').turn,2);
});

test('a mismatched quote asks the model to quote again, not the user to repeat',()=>{
  const requests=new UserRequests();requests.append('look up my notes',0,true);
  assert.throws(()=>requests.authorize('fetch the notion page'),/do not ask the user to repeat/i);
});

// ---- B14: a reply to a request made in this call is read back ----

const receipt={key:'action:s_live:1',id:'r1',sessionId:'s_live',kind:'bb_tell_thread',threadId:'thr_mgr',title:'Manager',
  at:'2026-09-26T19:14:34.060Z',status:'sent',summary:'Retrieve the Notion mountain biking notes'};
const idle=(updatedAt)=>({id:'thr_mgr',title:'Manager',updatedAt});

test('the answer to a request made in this call is read back without asking',async()=>{
  const map=new Map([[receipt.key,receipt]]);
  const store={get:async k=>map.get(k),set:async(k,v)=>{map.set(k,v);},list:async(p='')=>[...map.keys()].filter(k=>k.startsWith(p))};
  let heard=null;
  const live={closing:false,sessionId:'s_live',notifyWorker(a){heard=a;return true;}};
  const handle=createWorkerEventHandler({store,session:()=>live,now:()=>Date.parse('2026-09-26T19:14:53Z')});
  const result=await handle('thread.idle',{thread:idle(1),lastAssistantText:'I pulled up the live page, How I mountain bike.'});
  assert.equal(result.spoken,true);
  assert.equal(heard.askedThisCall,true);
  const text=announcementText(heard);
  assert.match(text,/read the thread now/i);
  assert.match(text,/do not ask whether/i);
  assert.doesNotMatch(text,/offer to inspect/);
  // Held while muted, the batch keeps the read-back.
  assert.match(batchAnnouncementText([heard],'quiet'),/read the thread now/i);
});

test('a reply to an earlier call’s request is mentioned, not read out unasked',async()=>{
  const text=announcementText({threadId:'thr_mgr',title:'Manager',state:'replied',snippet:'x',assignment:'y',otherReceipts:0,askedThisCall:false});
  assert.doesNotMatch(text,/read the thread now/i);
});

test('a queued message is answered only once it has run, not when the busy turn before it ends',()=>{
  const at=Date.parse('2026-09-26T19:14:53Z');
  const queued={...receipt,status:'queued'};
  const busyTurnEnds=correlateWorkerEvent({receipts:[queued],event:'thread.idle',thread:{...idle(1),queuedMessageCount:1},lastAssistantText:'Old turn answer',at});
  assert.deepEqual(busyTurnEnds,{updates:[],announcement:null});
  const answered=correlateWorkerEvent({receipts:[queued],event:'thread.idle',thread:{...idle(2),queuedMessageCount:0},lastAssistantText:'Here are your notes',at:at+60000});
  assert.equal(answered.updates[0].workerSnippet,'Here are your notes');
  assert.ok(answered.announcement);
});

test('a restored notice from an earlier call is never read back as asked in this call',()=>{
  const text=batchAnnouncementText([{threadId:'thr_mgr',title:'Manager',state:'replied',snippet:'x',restored:true,askedThisCall:true}],'review');
  assert.doesNotMatch(text,/asked for this in the current call/);
});

test('a long-lived thread’s later replies are not attributed to an old, already-answered request',()=>{
  const at=Date.parse('2026-09-26T19:14:53Z');
  const first=correlateWorkerEvent({receipts:[receipt],event:'thread.idle',thread:idle(1),lastAssistantText:'Here are your notes',at});
  assert.equal(first.updates[0].workerState,'replied');
  // B19: within the same call too, the answer is kept once settled (the 17:40:10 unrelated turn
  // overwrote it in the real call). Settling in worker-events decides which idle is the answer.
  const again=correlateWorkerEvent({receipts:[first.updates[0]],event:'thread.idle',thread:idle(5),lastAssistantText:'More detail',at:at+60000});
  assert.equal(again.updates[0].workerSnippet,'Here are your notes');
  assert.equal(again.announcement,null);
  // 17:17 the same day, from another call or none: the manager thread replied to something unrelated.
  const later=correlateWorkerEvent({receipts:[first.updates[0]],event:'thread.idle',thread:idle(2),lastAssistantText:'Unrelated reply',at:at+5*3600000});
  assert.equal(later.announcement,null,'not announced as news about this request');
  assert.equal(later.updates[0].workerSnippet,'Here are your notes','the answer is not overwritten by an unrelated reply');
  // An agent that was waiting on input and then replies is still reported.
  const waiting={...receipt,workerState:'needs-input',workerEventKey:'interaction.pending:1'};
  assert.equal(correlateWorkerEvent({receipts:[waiting],event:'thread.idle',thread:idle(3),at}).updates[0].workerState,'replied');
});
