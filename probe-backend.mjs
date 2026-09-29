// Created: 2026-09-28. Offline backend-model benchmark. Not part of the plugin runtime.
//
// Replays fixed voice requests through the Responses API with the SAME backend instructions
// and tool definitions a live call uses, and times each model/effort. READ tools run for real
// against BB; every write or action tool is STUBBED, and the BB CLI itself is wrapped so only
// read verbs can run. Nothing in BB is changed.
//
//   node probe-backend.mjs --cases cases.json [--configs terra,terra:low,luna] [--runs 3]
//     [--concurrency 4] [--out results.jsonl] [--judge gpt-6-sol] [--no-judge]
//
// Settings (credential file, CLI path, name, time zone, operating context) are read from the
// installed plugin's configuration, so the prompt matches what a live call sends.
import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { config, backendOptions, decodeToolCall } from './live-session.mjs';
import { createReader, createCli } from './bb-read.mjs';
import { createManager } from './bb-manager.mjs';
import { findThoughts } from './ambient.mjs';
import { setProfile } from './profile.mjs';
import { timeContext } from './reliability.mjs';
import { loadOperatingContext, operatingBriefing, trimOperatingContext } from './operating-context.mjs';

// USD per 1M tokens, short context (developers.openai.com/api/docs/pricing, read 2026-09-28).
// Fast mode (service_tier fast/priority) is listed at 2x input, cached and output; the 2x on
// cache writes is assumed. input_tokens includes cached and cache-write tokens.
export const PRICES = {
  'gpt-5.6-luna': { input: 0.20, cached: 0.02, write: 0.25, output: 0.75 },
  'gpt-5.6-terra': { input: 2.00, cached: 0.20, write: 2.50, output: 12.00 },
  'gpt-5.6-sol': { input: 4.00, cached: 0.40, write: 5.00, output: 20.00 },
  'gpt-6-luna': { input: 0.10, cached: 0.01, write: 0.125, output: 0.50 },
  'gpt-6-sol': { input: 2.00, cached: 0.20, write: 2.50, output: 10.00 },
  'gpt-6-astra': { input: 10.00, cached: 1.00, write: 12.50, output: 50.00 },
};
/** Cost in USD, split into the four billed parts. */
export function cost(model, tier, u) {
  const p = PRICES[model]; if (!p) return null;
  const m = ['fast', 'priority'].includes(tier) ? 2 : 1;
  const parts = { input: (u.input - u.cached - u.written) * p.input, cached: u.cached * p.cached, write: u.written * p.write, output: u.output * p.output };
  for (const k in parts) parts[k] = m * parts[k] / 1e6;
  return { total: parts.input + parts.cached + parts.write + parts.output, ...parts };
}
const ALIASES = { terra: 'gpt-5.6-terra', luna: 'gpt-5.6-luna', sol: 'gpt-5.6-sol', 'luna6': 'gpt-6-luna', 'sol6': 'gpt-6-sol', astra: 'gpt-6-astra' };
/** "terra:low:priority" -> backend options */
export function parseConfig(spec) {
  const [m, effort = '', tier = ''] = spec.split(':');
  return { label: spec, ...backendOptions({ model: ALIASES[m] ?? m, reasoning: effort, serviceTier: tier }) };
}

// Everything the backend can call that is not a pure read. Each gets a plausible receipt so the
// model's follow-through can be judged, and the call itself is recorded.
export const STUBBED = new Set(['bb_spawn_thread', 'bb_tell_thread', 'bb_stop_thread', 'bb_focus_thread', 'bb_talk_to_worker',
  'bb_view_screen', 'bb_note_commitment', 'bb_close_commitment', 'bb_capture_thought', 'bb_forget_thought',
  'bb_review_start', 'bb_review_note', 'bb_review_adopt', 'bb_review_list', 'bb_review_updates', 'bb_review_await', 'bb_review_handoff', 'bb_review_end']);
export function stub(name, args) {
  const at = new Date().toISOString();
  if (name === 'bb_spawn_thread') return { receipt: { id: 'bench-stub', kind: name, status: 'started', at, threadId: 'thr_benchstub', title: args.title ?? 'New task', model: args.profile ?? null } };
  if (name === 'bb_tell_thread') return { receipt: { id: 'bench-stub', kind: name, status: 'sent', at, threadId: args.threadId, mode: args.mode }, attachment: { saved: false, delivered: false } };
  if (name === 'bb_stop_thread') return { receipt: { id: 'bench-stub', kind: name, status: 'stopped', at, threadId: args.threadId } };
  if (name === 'bb_focus_thread') return { receipt: { id: 'bench-stub', kind: name, status: 'focused', at, threadId: args.threadId } };
  if (name === 'bb_note_commitment') return { receipt: { id: 'bench-stub', kind: name, status: 'open', at, summary: args.text, dueDate: args.dueDate }, recorded: true,
    note: 'Recorded durably and it survives this call. No agent was assigned and no work was done; say only that it is written down.' };
  if (name === 'bb_capture_thought') return { stored: true, id: 'tht_benchstub000000', note: 'Saved. Say only "Got it."' };
  if (name === 'bb_view_screen') return { error: 'The user is not sharing a screen right now, so there is nothing to look at.' };
  return { ok: true, stub: true };
}

// Only read verbs reach the real CLI, whatever a tool implementation asks for.
const READ_VERBS = new Set(['list', 'show', 'log', 'search', 'count', 'content', 'files', 'paths']);
export function readOnlyCli(cli) {
  return (args, json) => {
    const [noun, verb, sub] = args;
    const ok = ['thread', 'project', 'environment', 'machine', 'skill', 'plugin'].includes(noun)
      && (READ_VERBS.has(verb) || (noun === 'thread' && ['interactions', 'queue'].includes(verb) && sub === 'list'));
    if (!ok) throw new Error(`bench: refused non-read CLI call (${noun} ${verb})`);
    return cli(args, json);
  };
}
const emptyStore = { get: async () => null, list: async () => [], set: async () => { throw new Error('bench: store is read-only'); } };

function arg(name, fallback) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; }

async function sse(response, onEvent) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (data && data !== '[DONE]') onEvent(JSON.parse(data));
    }
  }
}

/** One request, all rounds, timed. */
async function runOne({ key, base, backend, say, execute, oneRound = false }) {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: say }] }];
  const t0 = performance.now();
  const record = { firstMs: null, firstToolMs: null, firstTextMs: null, rounds: 0, tools: [], answer: '', error: null,
    usage: { input: 0, cached: 0, written: 0, output: 0, reasoning: 0 }, firstRound: null };
  const intervals = [];
  for (let round = 0; round < (oneRound ? 1 : 8); round++) {
    record.rounds++;
    const body = { ...base, model: backend.model, input, store: false, stream: true, include: ['reasoning.encrypted_content'],
      ...(backend.reasoning ? { reasoning: { effort: backend.reasoning } } : {}), ...(backend.serviceTier ? { service_tier: backend.serviceTier } : {}) };
    const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { record.error = `${res.status} ${(await res.text()).slice(0, 400)}`; break; }
    const pending = []; let final = null; let text = '';
    await sse(res, e => {
      const t = performance.now() - t0;
      if (e.type === 'response.output_text.delta') { text += e.delta; if (record.firstTextMs === null) record.firstTextMs = t; if (record.firstMs === null) record.firstMs = t; }
      if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
        if (record.firstToolMs === null) record.firstToolMs = t;
        if (record.firstMs === null) record.firstMs = t;
        const call = e.item; const started = performance.now();
        // Colton's fork: the backend calls one compact bb_call tool; score the operation it names.
        let op; try { op = decodeToolCall(call); } catch { op = { name: call.name, args: null }; }
        const entry = { name: op.name, args: op.args ? JSON.stringify(op.args) : call.arguments, round, output: null, ms: null, stubbed: STUBBED.has(op.name) };
        record.tools.push(entry);
        pending.push(Promise.resolve().then(() => { if (!op.args) throw new Error('Unknown BB operation or invalid args string.'); return execute(op.name, op.args); })
          .catch(error => ({ error: error?.name === 'ActionError' ? error.message : `BB tool failed: ${String(error?.message ?? error).slice(0, 200)}` }))
          .then(result => { const ended = performance.now(); entry.ms = ended - started; intervals.push([started, ended]); entry.output = JSON.stringify(result);
            return { type: 'function_call_output', call_id: call.call_id, output: entry.output }; }));
      }
      if (e.type === 'response.completed' || e.type === 'response.incomplete') final = e.response;
      if (e.type === 'response.failed' || e.type === 'error') record.error = JSON.stringify(e.response?.error ?? e.error ?? e).slice(0, 400);
    });
    if (record.error || !final) { record.error ??= 'stream ended without completion'; break; }
    const u = final.usage ?? {};
    record.usage.input += u.input_tokens ?? 0; record.usage.cached += u.input_tokens_details?.cached_tokens ?? 0;
    record.usage.written += u.input_tokens_details?.cache_write_tokens ?? 0;
    if (round === 0) record.firstRound = { ms: performance.now() - t0, input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, written: u.input_tokens_details?.cache_write_tokens ?? 0 };
    if (oneRound) { record.answer = text; break; }
    record.usage.output += u.output_tokens ?? 0; record.usage.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0;
    if (!pending.length) { record.answer = text; break; }
    input.push(...final.output, ...(await Promise.all(pending)));
  }
  record.totalMs = performance.now() - t0;
  // Parallel tools overlap; count the wall time they cover once.
  let toolMs = 0, end = -Infinity;
  for (const [a, b] of intervals.sort((x, y) => x[0] - y[0])) { if (b > end) { toolMs += b - Math.max(a, end); end = b; } }
  record.toolMs = toolMs; record.modelMs = record.totalMs - toolMs;
  return record;
}

/** Tool choice: every `must` tool called, at least one of `oneOf`, none of `forbid`. */
export function toolCheck(expect = {}, called) {
  const names = new Set(called);
  const missing = (expect.must ?? []).filter(n => !names.has(n));
  const oneOf = expect.oneOf?.length ? expect.oneOf.some(n => names.has(n)) : true;
  const forbidden = (expect.forbid ?? []).filter(n => names.has(n));
  return { ok: !missing.length && oneOf && !forbidden.length, missing, oneOfMet: oneOf, forbidden };
}

const JUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'hallucination', 'note'],
  properties: { verdict: { type: 'string', enum: ['good', 'partial', 'wrong'] }, hallucination: { type: 'boolean' }, note: { type: 'string' } } };
async function judge({ key, model, c, record, context = '' }) {
  // Generous per-tool windows: a grader that sees a truncated thread flags true facts as invented.
  let budget = 60000;
  const tools = record.tools.map(t => { const o = (t.output ?? '').slice(0, Math.max(2000, Math.min(16000, budget))); budget -= o.length;
    return `- ${t.name}${t.stubbed ? ' (action, stubbed receipt)' : ''} args=${t.args}\n  output=${o}${o.length < (t.output ?? '').length ? ' [...truncated for grading]' : ''}`; }).join('\n');
  const prompt = `You grade a voice assistant's BACKEND answer. The backend reads a BB workspace (agent threads) with tools and answers the user's spoken request; a voice model then speaks the answer.
Context the backend had besides tools: its instructions state today's date and time zone (${context}), the user's name, and that email/Slack are drafts only; statements of those are supported.
User said: "${c.say}"
What a good answer does: ${c.good}
Tool calls it made, with their actual outputs (outputs may be truncated here):
${tools || '(none)'}
Final answer text:
"""${record.answer || '(empty)'}"""
Grade: verdict good = answers the request correctly and usefully from the tool outputs (or correctly performs/reports the requested action); partial = right direction but misses something material, hedges needlessly, or is too long for speech; wrong = wrong answer, wrong action, or no answer. hallucination = true only if it states a specific fact (status, result, count, thread, date) that the tool outputs contradict or do not contain; if an output was truncated for grading, do not flag facts that could be in the missing part. Stubbed receipts count as real receipts. One-sentence note.`;
  const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: prompt, store: false, text: { format: { type: 'json_schema', name: 'grade', strict: true, schema: JUDGE_SCHEMA } } }) });
  if (!res.ok) return { verdict: 'ungraded', hallucination: null, note: `judge ${res.status}` };
  const data = await res.json();
  const out = data.output?.flatMap(o => o.content ?? []).find(c => c.type === 'output_text')?.text;
  try { return JSON.parse(out); } catch { return { verdict: 'ungraded', hallucination: null, note: 'judge parse failed' }; }
}

async function main() {
  const bbCli = process.env.BB_CLI || 'bb';
  const settings = JSON.parse(execFileSync(bbCli, ['plugin', 'config', 'talk-to-bb', '--json'], { encoding: 'utf8' })).values;
  const env = Object.fromEntries((await readFile(settings.credentialFile, 'utf8')).split('\n')
    .map(l => l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)).filter(Boolean).map(m => [m[1], m[2]]));
  const key = env.OPENAI_API_KEY; if (!key) throw new Error('No OPENAI_API_KEY in the configured credential file.');
  setProfile({ name: settings.userName, machine: settings.preferredMachine, workerRules: settings.workerRules });
  const serverUrl = process.env.BB_SERVER_URL || 'http://127.0.0.1:38886';
  const cli = readOnlyCli(createCli({ cliPath: settings.cliPath, serverUrl, timeout: 60000 }));
  const reader = createReader({ cliPath: settings.cliPath, serverUrl, run: undefined });
  const manager = createManager({ cli, store: emptyStore, requests: { authorize() { throw new Error('bench: no writes'); } }, sessionId: 'bench', focus: async () => { throw new Error('bench'); } });
  // The user's notes, read once through the plugin's read-only list RPC, served from memory.
  const listed = await fetch(`${serverUrl}/api/v1/plugins/talk-to-bb/rpc/thought`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'list', limit: 200 }) }).then(r => r.json()).catch(() => ({})); // an older install has no thought RPC
  const notes = (listed.result ?? listed).thoughts ?? [];
  const noteStore = { list: async () => notes.map(n => `thought:${n.capturedAt}:${n.id}`), get: async k => notes.find(n => k.endsWith(`:${n.id}`)) ?? null };
  const execute = async (name, args) => {
    if (STUBBED.has(name)) return stub(name, args);
    if (name === 'bb_recall_thoughts') return { ...(await findThoughts(noteStore, args)), note: 'These are the user\'s personal notes.' };
    if (['bb_execution_options', 'bb_recent_actions', 'bb_outstanding'].includes(name)) return manager(name, args);
    return reader(name, args);
  };
  const time = timeContext(new Date(), settings.timeZone);
  const operating = await loadOperatingContext(settings.operatingContextFile).catch(() => null);
  const prompts = arg('prompts', 'full').split(',');
  // One backend prompt per standing-context mode, built exactly as server.ts builds it.
  // `context` is the browser-selection hint; the cold test varies it to force a new cache prefix.
  // Modes: full | brief | off (standing context only), lean (phone tool set + brief context).
  const baseFor = (mode, context = { threadId: null, projectId: null }) => {
    const standing = operating ? operatingBriefing(trimOperatingContext(operating, mode === 'lean' ? 'brief' : mode)) : '';
    const { model: _m, ...base } = config(context, { time, standing, toolset: mode === 'lean' ? 'lean' : 'full' }).delegation.responses;
    return base;
  };
  const bases = Object.fromEntries(prompts.map(p => [p, baseFor(p)]));

  const configs = (arg('configs', 'terra,terra:low,luna,luna:low,luna6,sol6')).split(',').map(parseConfig);
  const runs = Number(arg('runs', 3)); const concurrency = Number(arg('concurrency', 4));
  const out = arg('out', `/tmp/talk-to-bb-bench-${Date.now()}.jsonl`);
  const judgeModel = process.argv.includes('--no-judge') ? null : arg('judge', 'gpt-6-sol');
  if (process.argv.includes('--cold')) return cold({ key, configs, prompts, runs, baseFor, out, execute });
  const cases = JSON.parse(await readFile(arg('cases'), 'utf8'));
  // Interleaved: run r of every config and case before run r+1, so drift in BB or the API spreads evenly.
  const jobs = [];
  for (let r = 0; r < runs; r++) for (const c of cases) for (const p of prompts) for (const b of configs) jobs.push({ r, c, b, p });
  console.error(`${jobs.length} runs -> ${out}; ${prompts.map(p => `${p}: ${bases[p].instructions.length} chars`).join(', ')}; ${bases[prompts[0]].tools.length} tools`);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const { r, c, b, p } = jobs[next++];
      const record = await runOne({ key, base: bases[p], backend: b, say: c.say, execute }).catch(e => ({ error: String(e), tools: [], usage: { input: 0, cached: 0, written: 0, output: 0, reasoning: 0 } }));
      const check = toolCheck(c.expect, record.tools.map(t => t.name));
      const grade = judgeModel && !record.error ? await judge({ key, model: judgeModel, c, record, context: `${time.weekday} ${time.today} ${time.localTime}, ${time.timeZone}` }) : null;
      const row = { at: new Date().toISOString(), run: r, case: c.id, config: b.label, prompt: p, model: b.model, effort: b.reasoning || 'default', tier: b.serviceTier || 'default',
        ...record, tools: record.tools.map(t => ({ name: t.name, args: t.args, ms: t.ms, stubbed: t.stubbed, round: t.round, outputChars: t.output?.length ?? 0, output: t.output })),
        cost: cost(b.model, b.serviceTier, record.usage), check, grade };
      await appendFile(out, JSON.stringify(row) + '\n');
      console.error(`[${++done}/${jobs.length}] ${b.label.padEnd(16)} ${p.padEnd(5)} ${c.id.padEnd(10)} ${record.error ? 'ERROR ' + record.error.slice(0, 120) : `${Math.round(record.totalMs)}ms model ${Math.round(record.modelMs)}ms tools ${row.tools.map(t => t.name).join(',')} ${check.ok ? 'OK' : 'MISS'} ${grade?.verdict ?? ''}`}`);
    }
  }));
}

/**
 * New-session cost and latency. A new voice session sends a backend prompt whose browser/time
 * lines differ from any earlier session, so everything from there on is a cache write. For each
 * config and prompt mode: one first-round request with a never-seen prefix (cold), then the same
 * prefix again (warm). First round only; tools are not executed.
 */
async function cold({ key, configs, prompts, runs, baseFor, out, execute }) {
  const say = "What's running right now?";
  for (let r = 0; r < runs; r++) for (const p of prompts) for (const b of configs) {
    const base = baseFor(p, { threadId: null, projectId: null, session: `cold-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
    for (const phase of ['cold', 'warm']) {
      const record = await runOne({ key, base, backend: b, say, execute: async () => ({}), oneRound: true }).catch(e => ({ error: String(e) }));
      const row = { at: new Date().toISOString(), mode: 'cold-test', phase, run: r, config: b.label, model: b.model, effort: b.reasoning || 'default', tier: b.serviceTier || 'default', prompt: p,
        firstMs: record.firstMs, firstRoundMs: record.firstRound?.ms, usage: record.usage, error: record.error ?? null, cost: record.usage ? cost(b.model, b.serviceTier, record.usage) : null };
      await appendFile(out, JSON.stringify(row) + '\n');
      console.error(`${phase} ${b.label.padEnd(14)} ${p.padEnd(5)} first ${Math.round(record.firstMs ?? -1)}ms round ${Math.round(record.firstRound?.ms ?? -1)}ms in ${record.usage?.input} cached ${record.usage?.cached} written ${record.usage?.written} ${record.error ?? ''}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
