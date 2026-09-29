// Created: 2026-09-27. The "Hey BB" acknowledgement gets shorter over one Ambient run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ackText, spokenTitle } from '../hey-ack.mjs';
import { TalkSession } from '../live-session.mjs';

const T = (title, extra = {}) => ({ title, status: 'idle', hasPendingInteraction: false, ...extra });

test('first wake of a run: an overview and a question; then casual; then just "Hey."', () => {
  const threads = [T('Contract review', { hasPendingInteraction: true }), T('pocket-ios: build milestone 1 (Xcode on Mac)', { status: 'active' }), T('Idle thing')];
  const first = ackText({ calls: 0, threads });
  assert.equal(first.tier, 'overview');
  assert.equal(first.text, 'Hey. one thread needs you: Contract review; one is running. What do you want to work on?');
  assert.equal(ackText({ calls: 0, threads: [T('pocket-ios: build milestone 1 (Xcode on Mac)', { status: 'active' })] }).text,
    'Hey. one is running: pocket-ios, build milestone 1. What do you want to work on?');
  assert.equal(ackText({ calls: 0, threads: [] }).text, 'Hey. Nothing is running right now. What do you want to work on?');
  assert.equal(ackText({ calls: 0, threads: null }).text, "Hey, what's up?");
  assert.equal(ackText({ calls: 1 }).text, "Hey, what's up?");
  assert.equal(ackText({ calls: 2 }).text, "Hey, what's up?");
  assert.equal(ackText({ calls: 3 }).text, 'Hey.');
});

test('titles are said, not read', () => {
  assert.equal(spokenTitle('a b c d e f g h i'), 'a b c d e f g…');
  assert.equal(spokenTitle('**Bold** `code`'), 'Bold code');
});

test('a bare wake greets through an instructions append (the documented proactive path), not a thinking append', () => {
  const sent = [];
  const fake = Object.create(TalkSession.prototype);
  Object.assign(fake, { ready: true, closing: false, send: m => sent.push(m) });
  assert.equal(fake.greet("Hey, what's up?"), true);
  assert.equal(sent[0].type, 'session.instructions.append');
  assert.match(sent[0].content, /say exactly "Hey, what's up\?"/);
  fake.closing = true;
  assert.equal(fake.greet('Hey.'), false);
});
