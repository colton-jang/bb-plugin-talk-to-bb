// Created: 2026-09-28. Server-side timing of each delegated lookup: when the backend model
// started, when it first asked for a tool, how long each tool ran, and when its answer was
// ready. One record per lookup, so real walks can compare backend models and efforts.

/** Milliseconds covered by a set of [start,end] intervals (parallel tools overlap). */
function covered(intervals) {
  let total = 0, end = -Infinity;
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end); end = b;
  }
  return total;
}

export class LookupTimer {
  /** @param {{backend:{model:string,reasoning?:string,serviceTier?:string},now?:()=>number,onRecord:(record:any)=>void}} options */
  constructor({ backend, now = () => performance.now(), onRecord }) {
    Object.assign(this, { backend, now, onRecord });
    this.open = new Map();      // delegation id -> lookup in progress
    this.continuing = null;     // a lookup whose tool results were sent and whose next round has not started
  }
  created(delegationId) {
    const t = this.now();
    let lookup = this.open.get(delegationId);
    // A continued round may arrive under a new delegation id; it still belongs to the lookup that asked for it.
    if (!lookup && this.continuing) { lookup = this.continuing; this.open.set(delegationId, lookup); }
    this.continuing = null;
    if (!lookup) {
      lookup = { id: delegationId, start: t, rounds: 0, firstText: null, firstTool: null, tools: [], usage: { input: 0, cached: 0, written: 0, output: 0, reasoning: 0 } };
      this.open.set(delegationId, lookup);
    }
    lookup.rounds++;
  }
  text(delegationId) {
    const lookup = this.open.get(delegationId);
    if (lookup && lookup.firstText === null) lookup.firstText = this.now() - lookup.start;
  }
  toolStarted(delegationId, callId, name) {
    const lookup = this.open.get(delegationId);
    if (!lookup) return;
    const t = this.now();
    if (lookup.firstTool === null) lookup.firstTool = t - lookup.start;
    lookup.tools.push({ callId, name, start: t, end: null, ok: null });
  }
  toolDone(delegationId, callId, ok) {
    const tool = this.open.get(delegationId)?.tools.find(x => x.callId === callId && x.end === null);
    if (tool) { tool.end = this.now(); tool.ok = ok; }
  }
  /** usage: the Responses usage object on response.completed. */
  completed(delegationId, { usage = null, hasCalls = false } = {}) {
    const lookup = this.open.get(delegationId);
    if (!lookup) return;
    if (usage) {
      lookup.usage.input += usage.input_tokens ?? 0;
      lookup.usage.cached += usage.input_tokens_details?.cached_tokens ?? 0;
      lookup.usage.written += usage.input_tokens_details?.cache_write_tokens ?? 0;
      lookup.usage.output += usage.output_tokens ?? 0;
      lookup.usage.reasoning += usage.output_tokens_details?.reasoning_tokens ?? 0;
    }
    if (!hasCalls) this.finish(delegationId, 'answered');
  }
  continued(delegationId) { this.continuing = this.open.get(delegationId) ?? null; }
  failed(delegationId) { this.finish(delegationId, 'failed'); }
  /** Session ending: whatever was still running is reported as cut off, not silently dropped. */
  flush() { for (const id of [...this.open.keys()]) this.finish(id, 'cut-off'); }
  finish(delegationId, outcome) {
    const lookup = this.open.get(delegationId);
    if (!lookup) return;
    for (const [key, value] of this.open) if (value === lookup) this.open.delete(key);
    if (this.continuing === lookup) this.continuing = null;
    const end = this.now();
    const tools = lookup.tools.map(x => ({ name: x.name, ms: Math.round((x.end ?? end) - x.start), ok: x.ok }));
    const toolMs = Math.round(covered(lookup.tools.map(x => [x.start, x.end ?? end])));
    const totalMs = Math.round(end - lookup.start);
    try {
      this.onRecord({ id: lookup.id, outcome, model: this.backend.model, effort: this.backend.reasoning || 'default',
        tier: this.backend.serviceTier || 'default', rounds: lookup.rounds,
        firstToolMs: lookup.firstTool === null ? null : Math.round(lookup.firstTool),
        firstTextMs: lookup.firstText === null ? null : Math.round(lookup.firstText),
        totalMs, toolMs, modelMs: totalMs - toolMs, tools, usage: lookup.usage });
    } catch { /* timing must never disturb a call */ }
  }
}

/** The single bb.log line for one lookup. */
export function timingLine(r) {
  const tools = r.tools.length ? r.tools.map(t => `${t.name} ${t.ms}ms${t.ok === false ? ' FAILED' : ''}`).join(', ') : 'none';
  const u = r.usage;
  return `backend lookup ${r.id}: ${r.model} effort=${r.effort} tier=${r.tier} ${r.outcome}`
    + ` | first-tool ${r.firstToolMs ?? '-'}ms | tools ${tools}`
    + ` | answer ${r.totalMs}ms (model ${r.modelMs}ms, tools ${r.toolMs}ms, rounds ${r.rounds})`
    + ` | tokens in ${u.input} (cached ${u.cached}, cache-write ${u.written}) out ${u.output} (reasoning ${u.reasoning})`;
}
