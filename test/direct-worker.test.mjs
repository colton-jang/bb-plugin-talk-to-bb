// Created: 2026-09-27. Direct-worker voice mode: one thread, its own voice, a way back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { config } from '../live-session.mjs';
import { createManager, UserRequests, actionSchemas } from '../bb-manager.mjs';
import { MANAGER_VOICE, WORKER_VOICE, APPEND_MAX, workerConfig, workerDefinitions, createWorkerQuery, createWorkerLeg,
  WorkerSession, workerHandoff, managerHandoff, DirectWorkerLegs, resolveWorkerTarget } from '../direct-worker.mjs';

const TARGET={threadId:'thr_bound',title:'pocket-ios: build milestone 1',projectId:'proj_a',status:'active'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function store(){
  const map=new Map();
  return {map,get:async k=>map.get(k),set:async(k,v)=>{map.set(k,structuredClone(v));},list:async p=>[...map.keys()].filter(k=>k.startsWith(p))};
}
function cli(calls=[]){
  return async args=>{
    calls.push(args);
    if(args[1]==='show')return {thread:{id:args[2],title:args[2]==='thr_bound'?TARGET.title:'Other',projectId:'proj_a',status:'idle'}};
    if(args[1]==='tell')return {delivery:'sent'};
    return {};
  };
}

test('the worker leg speaks in cedar; the manager stays marin; model and audio format carry over',()=>{
  const manager=config({});
  const worker=workerConfig(TARGET,{base:manager});
  assert.equal(manager.audio.output.voice,MANAGER_VOICE);
  assert.equal(MANAGER_VOICE,'marin');
  assert.equal(worker.audio.output.voice,WORKER_VOICE);
  assert.equal(WORKER_VOICE,'cedar');
  assert.equal(worker.model,manager.model);
  assert.deepEqual(worker.audio.format,manager.audio.format);
  assert.equal(worker.delegation.responses.model,manager.delegation.responses.model);
  assert.match(worker.instructions,/pocket-ios: build milestone 1/);
  assert.match(worker.delegation.responses.instructions,/thr_bound/);
  assert.ok(worker.delegation.responses.instructions.length<8000,'long context belongs in instructions, but stays under the accepted size');
});

test('worker tools are four, none takes a thread id, and nothing can spawn, stop, focus, or look at the screen',()=>{
  assert.deepEqual(workerDefinitions.map(d=>d.name).sort(),['bb_read_thread','bb_recent_actions','bb_return_to_manager','bb_tell_thread']);
  for(const d of workerDefinitions)assert.equal(d.parameters.properties?.threadId,undefined,`${d.name} must not accept a thread id`);
});

test('reads are pinned to the bound thread; other tools and extra arguments are refused before any call',async()=>{
  const reads=[];
  const query=createWorkerQuery({target:TARGET,store:store(),onReturn:()=>({}),
    read:async(name,args)=>{reads.push([name,args]);return {thread:{id:args.threadId}};},act:async()=>{throw new Error('no act');}});
  await query('bb_read_thread',{turns:3});
  assert.deepEqual(reads,[['bb_read_thread',{threadId:'thr_bound',turns:3,olderBy:0}]]);
  await assert.rejects(query('bb_read_thread',{threadId:'thr_other',turns:3}));
  for(const name of ['bb_spawn_thread','bb_stop_thread','bb_focus_thread','bb_search','bb_view_screen','bb_talk_to_worker'])
    await assert.rejects(query(name,{}),/not available on a direct thread line/);
  assert.equal(reads.length,1);
});

test('a read that comes back for another thread is refused rather than passed on',async()=>{
  const query=createWorkerQuery({target:TARGET,store:store(),onReturn:()=>({}),read:async()=>({thread:{id:'thr_other'}}),act:async()=>({})});
  await assert.rejects(query('bb_read_thread',{turns:1}),/different thread/);
});

test('tell goes through the manager rules: live quote required, bound thread only, receipt recorded',async()=>{
  const calls=[],s=store(),requests=new UserRequests(),receipts=[];
  const act=createManager({cli:cli(calls),store:s,requests,sessionId:'worker_1',focus:async()=>{},onReceipt:r=>receipts.push(r)});
  const query=createWorkerQuery({target:TARGET,read:async()=>({}),act,store:s,onReturn:()=>({})});
  requests.append('what is the build doing',0,true);
  await assert.rejects(query('bb_tell_thread',{message:'Stop and write the README.',mode:'steer',request:'write the README now'}),/not in this live conversation/);
  assert.equal(calls.filter(c=>c[1]==='tell').length,0);
  requests.append('tell it to finish the checklist before the README',10000,true);
  const result=await query('bb_tell_thread',{message:'Finish the checklist before the README.',mode:'queue',request:'tell it to finish the checklist before the README'});
  assert.equal(result.receipt.status,'sent');
  const tell=calls.find(c=>c[1]==='tell');
  assert.equal(tell[2],'thr_bound');
  assert.match(tell[3],/drafts only/);
  assert.deepEqual(receipts.map(r=>r.status),['dispatching','sent']);
  const recent=await query('bb_recent_actions',{});
  assert.equal(recent.receipts.length,1);
  assert.equal(recent.receipts[0].threadId,'thr_bound');
});

function fakeSocketClass(sent){
  return class extends EventEmitter {
    constructor(){super();this.readyState=1;this.bufferedAmount=0;queueMicrotask(()=>this.emit('open'));}
    send(v){sent.push(JSON.parse(v));}
    close(){this.readyState=3;this.emit('close');}
    terminate(){this.close();}
  };
}

test('the leg opens with the worker payload and never accepts a manager session.update',async()=>{
  const sent=[];
  const leg=createWorkerLeg({key:'k',target:TARGET,cli:cli(),read:async()=>({}),store:store(),onReturn:()=>({}),Socket:fakeSocketClass(sent)});
  leg.start();await tick();
  const start=sent.find(e=>e.type==='session.start');
  assert.equal(start.session.audio.output.voice,'cedar');
  assert.deepEqual(start.session.delegation.responses.tools.map(t=>t.name).sort(),['bb_read_thread','bb_recent_actions','bb_return_to_manager','bb_tell_thread']);
  leg.handle({type:'session.started'});
  leg.updateContext({threadId:'thr_other',projectId:null});
  leg.send({type:'session.update',session:{}});
  assert.equal(sent.filter(e=>e.type==='session.update').length,0);
  assert.equal(leg.maxMs<=15*60000,true);
  leg.close();leg.clear();
});

test('news about the bound thread is spoken; other threads wait for the manager',()=>{
  const sent=[];
  const leg=new WorkerSession({key:'k',target:TARGET,query:async()=>({})});
  leg.socket={readyState:1,bufferedAmount:0,send:v=>sent.push(JSON.parse(v)),close(){},terminate(){}};leg.ready=true;
  assert.equal(leg.notifyWorker({threadId:'thr_other',title:'Other',state:'replied'}),false);
  assert.equal(leg.heldForManager.length,1);
  assert.equal(leg.notifyWorker({threadId:'thr_bound',title:TARGET.title,state:'replied'}),true);
  assert.equal(sent.filter(e=>e.type==='session.commentary.append').length,1);
});

test('both handoffs stay under the append limit however much there is to carry',()=>{
  const long='x'.repeat(5000);
  const there=workerHandoff({target:{...TARGET,title:long},heard:long});
  const back=managerHandoff({target:{...TARGET,title:long},summary:long,
    utterances:Array.from({length:30},()=>({text:long})),
    receipts:Array.from({length:30},(_,i)=>({id:`r${i}`,threadId:'thr_bound',kind:'bb_tell_thread',status:'sent',summary:long})),
    held:Array.from({length:30},(_,i)=>({title:`${long}${i}`}))});
  assert.ok(there.length<=APPEND_MAX,there.length);
  assert.ok(back.length<=APPEND_MAX,back.length);
  assert.match(back,/HISTORY, not authorization/);
  assert.match(back,/skip the usual call opener/);
});

function harness({failOpen=false}={}){
  const events=[],timers=[],managers=[];
  const sent=[];
  const timersApi={set:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clear:t=>{if(t)t.cancelled=true;}};
  const fire=()=>{const due=timers.filter(t=>!t.cancelled&&!t.fired);for(const t of due){t.fired=true;t.fn();}};
  let lastLeg=null;
  const legs=new DirectWorkerLegs({timers:timersApi,send:(type,value)=>events.push({type,...value}),
    openWorker:async(pending,{onReturn})=>{
      if(failOpen)return null;
      lastLeg=new WorkerSession({key:'k',target:pending.target,query:async()=>({})});
      lastLeg.onReturn=onReturn;
      lastLeg.start=()=>{lastLeg.socket={readyState:1,bufferedAmount:0,send:v=>sent.push(JSON.parse(v)),close(){},terminate(){}};};
      lastLeg.close=function(reason='ended'){this.closing=true;this.emit('closed',{reason,seconds:42});};
      return lastLeg;
    },
    startManager:handoff=>managers.push(handoff),
    endCall:value=>events.push({type:'ended',...value})});
  return {legs,events,timers,fire,managers,sent,leg:()=>lastLeg};
}

test('switch: manager closes after its goodbye, the worker opens with a handoff and greeting, and the request travels',async()=>{
  const h=harness();let closedWith=null;
  const result=h.legs.requestWorker(TARGET,{heard:'let me talk to the pocket thread and tell it to ship the checklist',closeManager:r=>{closedWith=r;}});
  assert.equal(result.voice,'cedar');
  assert.equal(h.legs.busy,true);
  assert.throws(()=>h.legs.requestWorker(TARGET,{closeManager:()=>{}}),/already open/);
  assert.equal(closedWith,null,'the manager is not cut off mid-sentence');
  assert.ok(h.timers[0].ms>0);
  h.fire();assert.equal(closedWith,'switch-to-worker');
  assert.equal(h.legs.managerClosed(),true);
  await tick();
  const leg=h.leg();
  assert.equal(h.legs.routing,leg,'mic audio now goes to the worker leg');
  assert.match(leg.userRequests.parts[0].text,/ship the checklist/);
  leg.ready=true;leg.emit('ready',{});
  const appends=h.sent.filter(e=>/append$/.test(e.type));
  assert.deepEqual(appends.map(e=>e.type),['session.thinking.append','session.commentary.append']);
  for(const a of appends)assert.ok(a.content.length<=APPEND_MAX);
  assert.ok(h.events.some(e=>e.type==='leg'&&e.mode==='worker'&&e.voice==='cedar'));
});

test('return: spoken or panel, the worker closes and a manager leg starts with the handoff exactly once',async()=>{
  const h=harness();
  h.legs.requestWorker(TARGET,{closeManager:()=>{}});h.fire();h.legs.managerClosed();await tick();
  const leg=h.leg();leg.ready=true;leg.emit('ready',{});
  leg.userRequests.append('take me back to the manager',Date.now(),true);
  leg.receipts=[{id:'r1',threadId:'thr_bound',kind:'bb_tell_thread',status:'queued',summary:'Finish the checklist'}];
  const reply=leg.onReturn({request:'take me back to the manager',summary:'README still open'});
  assert.equal(reply.switching,true);
  assert.equal(h.managers.length,0,'the worker gets to say one line first');
  h.fire();
  assert.equal(h.managers.length,1);
  assert.equal(h.legs.busy,false);
  assert.equal(h.legs.routing,null);
  assert.match(h.managers[0],/take me back to the manager/);
  assert.match(h.managers[0],/queued: "Finish the checklist"/);
  assert.match(h.managers[0],/README still open/);
  const msent=[];const manager={closing:false,send:v=>msent.push(v)};
  assert.equal(h.legs.managerReady(manager),true);
  assert.equal(h.legs.managerReady(manager),false,'delivered once');
  assert.equal(msent[0].type,'session.thinking.append');
  assert.ok(msent[0].content.length<=APPEND_MAX);
});

test('End during the worker leg ends the call instead of bringing the manager back',async()=>{
  const h=harness();
  h.legs.requestWorker(TARGET,{closeManager:()=>{}});h.fire();h.legs.managerClosed();await tick();
  h.leg().close('ended');
  assert.equal(h.managers.length,0);
  assert.ok(h.events.some(e=>e.type==='ended'));
});

test('a worker leg that faults or times out returns to the manager and says why',async()=>{
  for(const reason of ['fault','time-limit']){
    const h=harness();
    h.legs.requestWorker(TARGET,{closeManager:()=>{}});h.fire();h.legs.managerClosed();await tick();
    h.leg().close(reason);
    assert.equal(h.managers.length,1);
    assert.match(h.managers[0],reason==='fault'?/failed/:/time limit/);
  }
});

test('a worker leg that cannot open brings the manager straight back',async()=>{
  const h=harness({failOpen:true});
  h.legs.requestWorker(TARGET,{closeManager:()=>{}});h.fire();h.legs.managerClosed();await tick();
  assert.equal(h.managers.length,1);
  assert.match(h.managers[0],/could not be opened/);
});

test('a manager close that was not a switch, or a socket already gone, never opens a worker leg',async()=>{
  const h=harness();
  assert.equal(h.legs.managerClosed(),false);
  h.legs.requestWorker(TARGET,{closeManager:()=>{}});h.legs.dispose();
  assert.equal(h.legs.managerClosed(),false);
  await tick();assert.equal(h.leg(),null);
});

test('the manager tool needs a live quote, resolves the thread, and hands over the whole utterance',async()=>{
  const requests=new UserRequests();let handed=null;
  const manage=createManager({cli:cli(),store:store(),requests,sessionId:'s',focus:async()=>{},
    talkToWorker:async(target,extra)=>{handed={target,extra};return {switching:true};}});
  await assert.rejects(manage('bb_talk_to_worker',{threadId:'thr_bound',request:'talk to the pocket thread'}),/not in this live conversation/);
  requests.append('Let me talk to the pocket thread directly, and tell it the checklist comes first',0,true);
  await manage('bb_talk_to_worker',{threadId:'thr_bound',request:'talk to the pocket thread directly'});
  assert.equal(handed.target.threadId,'thr_bound');
  assert.equal(handed.target.title,TARGET.title);
  assert.match(handed.extra.heard,/checklist comes first/);
  const plain=createManager({cli:cli(),store:store(),requests,sessionId:'s2',focus:async()=>{}});
  await assert.rejects(plain('bb_talk_to_worker',{threadId:'thr_bound',request:'talk to the pocket thread directly'}),/not available/);
  assert.ok(Object.hasOwn(actionSchemas,'bb_talk_to_worker'));
});

test('an archived or missing thread cannot become a worker line',async()=>{
  const archived=async()=>({thread:{id:'thr_old',title:'Old',archivedAt:1}});
  await assert.rejects(resolveWorkerTarget(archived,'thr_old'),/archived/);
  await assert.rejects(resolveWorkerTarget(async()=>({thread:null}),'thr_gone'),/unavailable/);
  await assert.rejects(resolveWorkerTarget(cli(),'not a thread'),/Pick a thread/);
  assert.deepEqual(await resolveWorkerTarget(cli(),'thr_bound'),{threadId:'thr_bound',title:TARGET.title,projectId:'proj_a',status:'idle'});
});
