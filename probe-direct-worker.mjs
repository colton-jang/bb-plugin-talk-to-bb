// Created: 2026-09-27. Direct GPT-Live check of the worker leg WITHOUT the plugin route:
// it never touches /voice, the reservation, or a call in progress. One short paid session.
//   node probe-direct-worker.mjs <thr_id>     (run from this folder so `ws` resolves)
// Opens a cedar session with the worker config bound to one thread, streams silence, sends
// the manager handoff + greeting, then one typed question about the thread. Passes when the
// reply is spoken (audio bytes > 0) after a scoped bb_read_thread of the bound thread.
// Read-only toward BB: the action CLI refuses everything except `thread show`, so nothing
// can be sent to the thread even if the model tried. The key is read from the plugin's
// credentialFile setting (read-only `bb plugin config` show) and never printed.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createReader, createCli } from './bb-read.mjs';
import { createWorkerLeg, resolveWorkerTarget, workerHandoff, workerGreeting, APPEND_MAX } from './direct-worker.mjs';

const threadId = process.argv[2];
if (!threadId) throw new Error('Usage: node probe-direct-worker.mjs <thr_id>');
const cliPath = process.env.BB_CLI || 'bb';
const serverUrl = process.env.BB_SERVER_URL || 'http://127.0.0.1:38886';
const values = JSON.parse(execFileSync(cliPath, ['plugin', 'config', 'talk-to-bb', '--json'], { encoding: 'utf8' })).values ?? {};
const key = values.credentialFile ? parseEnv(await readFile(values.credentialFile, 'utf8')).OPENAI_API_KEY : '';
if (!key) throw new Error('No OPENAI_API_KEY in the configured credentialFile.');

const cli = createCli({ cliPath, serverUrl });
const readOnlyActions = async args => {
  if (args[0] === 'thread' && args[1] === 'show') return cli(args);
  throw new Error(`probe refuses BB mutation: ${args.slice(0, 2).join(' ')}`);
};
const map = new Map();
const store = { get: async k => map.get(k), set: async (k, v) => { map.set(k, v); }, list: async p => [...map.keys()].filter(k => k.startsWith(p)) };
const target = await resolveWorkerTarget(cli, threadId);
const reader = createReader({ cliPath, serverUrl });
const reads = [], mutations = [], faults = [];
let audioBytes = 0, transcript = '', greeted = false, answered = false;
const leg = createWorkerLeg({ key, target, cli: readOnlyActions, read: (n, a) => reader(n, a), store, timeZone: values.timeZone || 'UTC',
  onReceipt: r => mutations.push(r.kind), onReturn: () => ({ switching: false, note: 'probe' }) });
const started = Date.now();
let silence, finish, deadline;
const stop = () => { clearInterval(silence); clearTimeout(finish); clearTimeout(deadline); leg.close('ended'); };
deadline = setTimeout(stop, 55000);
leg.on('ready', () => {
  console.log(`cedar session ready for "${target.title}" (${target.threadId}) in ${Date.now() - started} ms`);
  // Appends complete only while input audio streams, so silence starts first.
  silence = setInterval(() => leg.audio(Buffer.alloc(640)), 20);
  const handoff = workerHandoff({ target, heard: 'Let me talk directly to the Pocket build thread.', time: leg.time });
  const greeting = workerGreeting(target);
  console.log(`handoff ${handoff.length} chars, greeting ${greeting.length} chars (cap ${APPEND_MAX})`);
  leg.handoff(handoff); leg.say(greeting);
  setTimeout(() => { greeted = transcript.length > 0; leg.ask('What is this thread working on right now, and is it blocked on anything? Read it first.'); }, 6000);
});
leg.on('audio', bytes => { audioBytes += bytes.length; });
leg.on('transcript', e => {
  if (e.speaker !== 'assistant') return;
  transcript += e.text;
  if (reads.length) { answered = true; clearTimeout(finish); finish = setTimeout(stop, 4000); }
});
leg.on('lookup', e => {
  if (e.state === 'done' && e.name === 'bb_read_thread') reads.push(e.result?.thread?.id ?? null);
  if (e.state !== 'reading') console.log(`lookup ${e.name}: ${e.state}`);
});
leg.on('fault', e => { faults.push(e.message); console.error(`fault: ${e.message}`); });
leg.on('closed', value => {
  clearInterval(silence); clearTimeout(finish); clearTimeout(deadline);
  const voice = 'cedar';
  const passed = !faults.length && audioBytes > 0 && reads.length > 0 && reads.every(id => id === target.threadId) && answered && mutations.length === 0;
  console.log(JSON.stringify({ passed, voice, thread: target.threadId, title: target.title, seconds: Math.round((Date.now() - started) / 1000),
    audioBytes, reads, mutations, faults, greetedBeforeQuestion: greeted, reason: value?.reason, transcript: transcript.slice(0, 1200) }, null, 1));
  if (!passed) process.exitCode = 1;
});
leg.start();
