// Created: 2026-09-27. Memory across the calls of one Ambient Walk run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalkMemory } from '../walk-memory.mjs';

const RUN='run_abcdef12';

test('earlier calls of the run come back as history; the current call does not', () => {
  const m=createWalkMemory();
  m.startCall(RUN);
  m.add(RUN,{speaker:'you',text:'Hey BB, what is '});m.add(RUN,{speaker:'you',text:'waiting on me?'});
  m.add(RUN,{speaker:'assistant',text:'Two threads need you.'});
  assert.equal(m.briefing(RUN),'');
  m.startCall(RUN);
  m.add(RUN,{speaker:'you',text:'And the second one?'});
  const b=m.briefing(RUN);
  assert.match(b,/User: Hey BB, what is waiting on me\? \| You: Two threads need you\.$/);
  assert.doesNotMatch(b,/second one/);
});

test('calls are separated, trimming keeps the newest, other runs and bad ids stay apart', () => {
  const m=createWalkMemory();
  for(let i=0;i<3;i++){m.startCall(RUN);m.add(RUN,{speaker:'you',text:`question ${i} `+'x'.repeat(200)});}
  m.startCall(RUN);
  const b=m.briefing(RUN,300);
  assert.match(b,/question 2/);assert.doesNotMatch(b,/question 0/);
  const full=m.briefing(RUN,5000);assert.match(full,/question 0.*— \| User: question 1/);
  assert.equal(m.briefing('run_other123'),'');
  m.add('not-a-run',{speaker:'you',text:'hi'});assert.equal(m.briefing('not-a-run'),'');
});

test('runs expire', () => {
  let t=0;const m=createWalkMemory({ttlMs:1000,now:()=>t});
  m.startCall(RUN);m.add(RUN,{speaker:'you',text:'hello'});m.startCall(RUN);
  assert.match(m.briefing(RUN),/hello/);
  t=5000;m.startCall('run_zzzzzzzz');
  assert.equal(m.briefing(RUN),'');
});

test('a captured thought is never replayed into the next call', () => {
  const m=createWalkMemory();
  m.startCall(RUN);
  m.add(RUN,{speaker:'you',text:'thought bubble, a pricing page with three months first'});
  m.redactLastUser(RUN);
  m.add(RUN,{speaker:'you',text:' and more words'});
  m.add(RUN,{speaker:'assistant',text:'Got it.'});
  m.startCall(RUN);
  const b=m.briefing(RUN);
  assert.doesNotMatch(b,/pricing|more words/);
  assert.match(b,/User: \[a private note was captured here\] \| You: Got it\./);
});
