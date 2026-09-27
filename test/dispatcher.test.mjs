// Created: 2026-09-15. The production dispatcher, not a mirror of it: these drive the real
// plugin factory from server.ts through BB's own plugin test host and emit real thread events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';

const ago=ms=>new Date(Date.now()-ms).toISOString();
const AT=ago(60*60000);
async function host(){
  const fake=createFakePluginHost({pluginId:'talk-to-bb',settings:{credentialFile:'/nonexistent/no-credentials'}});
  await plugin(fake.bb);
  return fake;
}
const receipt=(over={})=>({key:`action:s1:${over.id}`,id:'r',sessionId:'s1',kind:'bb_spawn_thread',status:'started',
  at:AT,threadId:'thr_worker',projectId:'proj_a',title:'Staffing sweep',model:'claude-opus-5[1m]',
  request:'have an agent sweep staffing',summary:'Sweep staffing',...over});
async function seed(bb,rows){for(const r of rows)await bb.storage.kv.set(r.key,r);}
const load=async(bb,key)=>bb.storage.kv.get(key);

test('the real dispatcher marks only the newest receipt for that thread on thread.idle',async()=>{
  const {bb,harness}=await host();
  await seed(bb,[
    receipt({id:'old',key:'action:s1:old',at:ago(180*60000),summary:'First assignment'}),
    receipt({id:'new',key:'action:s1:new',at:ago(120*60000),kind:'bb_tell_thread',status:'sent',summary:'Latest instruction'}),
    receipt({id:'other',key:'action:s1:other',at:ago(90*60000),threadId:'thr_elsewhere',title:'Other work'}),
    receipt({id:'focus',key:'action:s1:focus',at:ago(75*60000),kind:'bb_focus_thread',status:'focused'}),
  ]);
  const {errors}=await harness.emitThreadEvent('thread.idle',{
    thread:makeThreadResponse({id:'thr_worker',title:'Staffing sweep',updatedAt:1789000000000}),
    lastAssistantText:'  Wrote the draft and left it for review.\n',
  });
  assert.deepEqual(errors,[]);
  assert.equal((await load(bb,'action:s1:new')).workerState,'replied');
  assert.equal((await load(bb,'action:s1:new')).workerSnippet,'Wrote the draft and left it for review.');
  for (const key of ['action:s1:old','action:s1:other','action:s1:focus'])
    assert.equal((await load(bb,key)).workerState,undefined,`${key} must not be marked newly replied`);
});

test('the real dispatcher does not re-mark the same state on a repeated event',async()=>{
  const {bb,harness}=await host();
  await seed(bb,[receipt({id:'one',key:'action:s1:one'})]);
  const thread=makeThreadResponse({id:'thr_worker',title:'Staffing sweep',updatedAt:1789000000000});
  await harness.emitThreadEvent('thread.idle',{thread,lastAssistantText:'done'});
  const first=await load(bb,'action:s1:one');
  assert.equal(first.workerState,'replied');
  await harness.emitThreadEvent('thread.idle',{thread,lastAssistantText:'done'});
  assert.deepEqual(await load(bb,'action:s1:one'),first,'an identical event must change nothing at all');
  // A genuinely newer event for the same thread does update it.
  await harness.emitThreadEvent('thread.idle',{thread:{...thread,updatedAt:1789000009999},lastAssistantText:'done again'});
  assert.notEqual((await load(bb,'action:s1:one')).workerEventKey,first.workerEventKey);
});

test('the real dispatcher maps failure and pending-input events to their own states',async()=>{
  for (const [event,state,extra] of [['thread.failed','failed',{error:'provider error'}],['interaction.pending','needs-input',{interaction:{}}]]) {
    const {bb,harness}=await host();
    await seed(bb,[receipt({id:'one',key:'action:s1:one'})]);
    const {errors}=await harness.emitThreadEvent(event,
      {thread:makeThreadResponse({id:'thr_worker',title:'Staffing sweep',updatedAt:1789000000000}),...extra});
    assert.deepEqual(errors,[]);
    assert.equal((await load(bb,'action:s1:one')).workerState,state);
  }
});

test('the real dispatcher is a no-op for a thread nobody was asked to manage',async()=>{
  const {bb,harness}=await host();
  await seed(bb,[receipt({id:'one',key:'action:s1:one'})]);
  const before=await load(bb,'action:s1:one');
  const {errors}=await harness.emitThreadEvent('thread.idle',{
    thread:makeThreadResponse({id:'thr_unrelated',title:'Something else'}),lastAssistantText:'hello'});
  assert.deepEqual(errors,[]);
  assert.deepEqual(await load(bb,'action:s1:one'),before);
  assert.equal(await load(bb,'action:s1:unrelated'),undefined);
});

test('the real dispatcher never correlates a dispatch made after the event',async()=>{
  const {bb,harness}=await host();
  const future=new Date(Date.now()+10*60000).toISOString();
  await seed(bb,[receipt({id:'later',key:'action:s1:later',at:future})]);
  await harness.emitThreadEvent('thread.idle',{
    thread:makeThreadResponse({id:'thr_worker',title:'Staffing sweep',updatedAt:1789000000000}),lastAssistantText:'done'});
  assert.equal((await load(bb,'action:s1:later')).workerState,undefined);
});

test('the real status RPC reports unconfigured without credentials and claims no active session',async()=>{
  const {bb,harness}=await host();
  const status=await harness.callRpc('status',null);
  assert.deepEqual(status,{configured:false,active:false});
  // The read contract is registered too, and an unknown tool name is refused rather than run.
  await assert.rejects(harness.callRpc('read',{name:'bb_delete_everything',args:{}}));
  void bb;
});

// The compact entrypoint keeps the full operation catalog while keeping each
// Responses request below a low per-minute token limit.
test('the model receives one strict compact tool and can decode only known operations',async()=>{
  const {config,decodeToolCall}=await import('../live-session.mjs');
  const tools=config({}).delegation.responses.tools;
  assert.equal(tools.length,1);
  assert.equal(tools[0].name,'bb_call');
  for (const tool of tools) {
    const where=`tool ${tool.name}`;
    assert.equal(tool.type,'function',where);
    assert.equal(tool.strict,true,`${where} must be strict`);
    assert.ok(tool.description?.length>20,`${where} needs a real description`);
    const schema=tool.parameters;
    assert.equal(schema.type,'object',where);
    assert.equal(schema.additionalProperties,false,`${where} must forbid extra properties`);
    const properties=Object.keys(schema.properties??{});
    const required=schema.required??[];
    assert.deepEqual(properties.filter(k=>!required.includes(k)),[],
      `${where}: strict mode requires every property to be listed in required`);
  }
  const names=tools[0].parameters.properties.name.enum;
  assert.ok(names.length>=26);
  assert.equal(new Set(names).size,names.length);
  for(const name of names)assert.match(config({}).delegation.responses.instructions,new RegExp(`${name}\\(`));
  assert.deepEqual(decodeToolCall({name:'bb_call',arguments:JSON.stringify({name:'bb_projects',args:'{}'})}),
    {name:'bb_projects',args:{}});
  assert.throws(()=>decodeToolCall({name:'bb_call',arguments:JSON.stringify({name:'bb_delete_everything',args:'{}'})}),/Unknown BB operation/);
});
