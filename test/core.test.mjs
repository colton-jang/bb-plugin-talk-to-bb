// Created: 2026-09-15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReader, currentThreads } from '../bb-read.mjs';
import { TalkSession, rateLimitDelay } from '../live-session.mjs';

test('read tools reject mutation names, flags, invalid IDs and extra arguments before running a process',async()=>{
  let calls=0;const query=createReader({cliPath:'/bb',serverUrl:'http://127.0.0.1',run:async()=>{calls++;return {stdout:'[]'};}});
  for(const [name,args] of [['bb_spawn',{}],['bb_search',{query:'--help'}],['bb_read_thread',{threadId:'thr_x;rm -rf /',turns:2}],['bb_projects',{command:'delete'}]]){
    await assert.rejects(query(name,args));
  }
  assert.equal(calls,0);
});

test('overview uses authoritative count and excludes archived, hidden, and deleted list rows',async()=>{
  const query=createReader({cliPath:'/bb',serverUrl:'http://local',run:async(path,args,options)=>{
    assert.equal(options.shell,false);assert.equal(path,'/bb');assert.equal(options.env.BB_SERVER_URL,'http://local');
    const stdout=args[1]==='count'?{total:900,groups:[]}:args[0]==='project'?[{id:'proj_a',name:'A'}]:[
      {id:'thr_a',title:'Needs a decision',status:'idle',hasPendingInteraction:true,updatedAt:1},
      {id:'thr_b',status:'active',updatedAt:5},{id:'thr_c',archivedAt:1},{id:'thr_d',visibility:'hidden'},{id:'thr_e',deletedAt:1},
    ];return {stdout:JSON.stringify(stdout)};
  }});
  const result=await query('bb_overview',{});
  assert.equal(result.counts.total,900);assert.equal(result.threads.length,2);
  assert.equal(result.threads[0].id,'thr_a');assert.equal(result.threads[0].status,'idle');assert.match(result.coverage,/bounded/);
});

test('search preserves shell-like text as one literal argument without executing it',async()=>{
  let seen;const query=createReader({cliPath:'/bb',serverUrl:'http://local',run:async(path,args,options)=>{seen={args,options};return {stdout:'{"active":{"total":0,"results":[]}}'};}});
  await query('bb_search',{query:'proposal $(touch /tmp/unwanted); echo nope'});
  assert.equal(seen.args[2],'proposal $(touch /tmp/unwanted); echo nope');assert.equal(seen.options.shell,false);
});

test('a compact thread read can omit the optional turn count',async()=>{
  const query=createReader({cliPath:'/bb',serverUrl:'http://local',run:async(path,args)=>{
    if(args[0]==='thread'&&args[1]==='show')return {stdout:JSON.stringify({thread:{id:'thr_a',projectId:'proj_a',status:'idle'}})};
    if(args[0]==='thread'&&args[1]==='log'){
      assert.equal(args[args.indexOf('--limit')+1],'5');
      return {stdout:'Recent conversation'};
    }
    return {stdout:'[]'};
  }});
  const result=await query('bb_read_thread',{threadId:'thr_a'});
  assert.equal(result.conversation,'Recent conversation');
});

function mock(query=async()=>({ok:true})) {
  const sent=[];const session=new TalkSession({key:'test',query});
  session.socket={readyState:1,bufferedAmount:0,send:value=>sent.push(JSON.parse(value)),close(){},terminate(){}};
  session.ready=true;return {session,sent};
}
const envelope=(event)=>({type:'response.event',delegation_id:'del_1',event});
const created=envelope({type:'response.created',response:{id:'r_1'}});
const completed=envelope({type:'response.completed',response:{id:'r_1',output:[]}});
const call=(id)=>envelope({type:'response.output_item.done',item:{type:'function_call',call_id:id,name:'bb_projects',arguments:'{}'}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('parallel results wait for all calls and terminal response, continuing exactly once',async()=>{
  const resolvers=[];const {session,sent}=mock(()=>new Promise(resolve=>resolvers.push(resolve)));
  session.handle(created);session.handle(call('a'));session.handle(call('b'));session.handle(call('a'));session.handle(completed);
  await tick();assert.equal(resolvers.length,2);
  resolvers[1]({ok:'b'});await tick();assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  resolvers[0]({ok:'a'});await tick();
  assert.deepEqual(sent.filter(e=>e.type==='response.item.create').map(e=>e.item.call_id),['b','a']);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);
  session.handle(completed);assert.equal(sent.filter(e=>e.type==='response.create').length,1);
});

test('fast tools still wait for response completion; failed reads return failure, not invented facts',async()=>{
  const {session,sent}=mock(async()=>{throw new Error('private path or credential');});
  session.handle(created);session.handle(call('a'));await tick();
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  assert.match(sent[0].item.output,/tool failed/);assert.doesNotMatch(sent[0].item.output,/credential/);
  session.handle(completed);assert.equal(sent.filter(e=>e.type==='response.create').length,1);
});

test('ending a session cancels lookups and ignores late results',async()=>{
  let finish;const {session,sent}=mock(()=>new Promise(resolve=>{finish=resolve;}));
  session.handle(created);session.handle(call('a'));session.handle(completed);await tick();
  session.close();finish({ok:true});await tick();
  assert.equal(session.controller.signal.aborted,true);
  assert.equal(sent.filter(e=>e.type==='response.item.create'||e.type==='response.create').length,0);session.clear();
});

test('a rate-limited backend continuation waits and retries once without ending voice',async()=>{
  const {session,sent}=mock();
  session.send({type:'response.create'});
  const first=sent[0].event_id;
  let fault=false;
  session.on('fault',()=>{fault=true;});
  session.handle({type:'error',error:{code:'invalid_request_error',client_event_id:first,
    message:'Rate limit reached for gpt-6-sol. Please try again in 0s.'}});
  assert.equal(fault,false);
  assert.equal(rateLimitDelay('unrelated failure'),null);
  await new Promise(resolve=>setTimeout(resolve,1300));
  assert.equal(sent.filter(event=>event.type==='response.create').length,2);
  session.close();session.clear();
});

test('mute blocks late audio, resume persists, and invalid PCM is ignored',()=>{
  const {session,sent}=mock();let audio=0;let flush=0;
  session.on('audio',()=>audio++);session.on('flush',()=>flush++);
  const e={type:'session.output_audio.delta',delta:Buffer.from([1,2,3,4]).toString('base64')};
  session.handle(e);session.mute(true);session.handle(e);assert.equal(audio,1);assert.equal(flush,1);
  session.mute(false);session.handle(e);assert.equal(audio,2);
  session.audio(Buffer.alloc(3));session.audio(Buffer.alloc(6402));session.audio(Buffer.alloc(640));
  assert.equal(sent.filter(e=>e.type==='session.input_audio.append').length,1);
});
