// Created: 2026-09-15. A bounded, read-only BB CLI interface.
import { execFile } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import { capabilitySchemas, capabilityDefinitions, createCapabilities } from './bb-capabilities.mjs';

const exec = promisify(execFile);
const id = z.string().regex(/^thr_[a-z0-9]+$/);
const project = z.string().regex(/^proj_[a-z0-9]+$/).nullable();
export const schemas = {
  bb_overview: z.object({}).strict(),
  bb_search: z.object({ query: z.string().trim().min(1).max(160) }).strict(),
  bb_threads: z.object({ projectId: project.default(null), status: z.enum(['all', 'active', 'idle', 'error', 'waiting']).default('all'), offset: z.number().int().min(0).max(10000).default(0) }).strict(),
  bb_read_thread: z.object({ threadId: id, turns: z.number().int().min(1).max(12).default(5) }).strict(),
  bb_projects: z.object({}).strict(),
};
const descriptions = {
  bb_overview: 'Read live BB counts, projects, and up to 20 current threads across ALL projects. Running and pending-interaction threads first. Idle does not mean finished. Use bb_read_thread for facts about work or blockers.',
  bb_search: 'Search titles and conversation messages across BB, including archived threads. Returns matching snippets and IDs. Search is bounded; read matching threads before explaining their decisions.',
  bb_threads: 'Page through current, unarchived visible threads, optionally filtered by project or state. Waiting means a pending BB interaction, not all work that may need user judgment. Page size 40.',
  bb_read_thread: 'Read current metadata, pending interactions, queued messages, and the latest conversation turns for one thread. Explicitly reports omitted older history. Read multiple threads when comparing work.',
  bb_projects: 'List BB projects and their names.',
};
export const toolDefinitions = [
  ...Object.entries(schemas).map(([name, schema]) => ({
    type: 'function', name, description: descriptions[name], strict: true,
    parameters: z.toJSONSchema(schema),
  })),
  ...capabilityDefinitions,
];

const short = (value, max = 22000) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
};
export function threadSummary(t) {
  return { id: t.id, title: t.title || t.titleFallback || 'Untitled', projectId: t.projectId,
    status: t.status, displayStatus: t.runtime?.displayStatus ?? t.status,
    hasPendingInteraction: t.hasPendingInteraction ?? null, queuedWork: t.queuedWork ?? null,
    archived: Boolean(t.archivedAt), updatedAt: t.updatedAt,
    parentThreadId: t.parentThreadId ?? null, hostId: t.environmentHostId ?? null };
}
export function currentThreads(rows) {
  if (!Array.isArray(rows)) throw new Error('Unexpected BB thread list response.');
  return rows.filter(t => !t.archivedAt && !t.deletedAt && t.visibility !== 'hidden')
    .sort((a,b) => Number(Boolean(b.hasPendingInteraction)) - Number(Boolean(a.hasPendingInteraction))
      || Number(['active','starting','error'].includes(b.status)) - Number(['active','starting','error'].includes(a.status))
      || b.updatedAt - a.updatedAt);
}

// The bb CLI is a JavaScript file that starts with `#!/usr/bin/env node`. A bb server
// launched by launchd has PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `env` finds no node and
// every call fails with "env: node: No such file or directory". Run those with the node
// already running this plugin; anything else (a native executable, a bare command name) is
// run as-is.
export function cliCommand(cliPath, args) {
  return needsNode(cliPath) ? [process.execPath, [cliPath, ...args]] : [cliPath, args];
}
function needsNode(cliPath) {
  if (/\.[cm]?js$/.test(cliPath)) return true;
  if (!cliPath.includes('/')) return false; // resolved through PATH, nothing to inspect
  let fd;
  try {
    fd = openSync(cliPath, 'r');
    const buf = Buffer.alloc(128);
    const head = buf.toString('utf8', 0, readSync(fd, buf, 0, 128, 0));
    return /^#!\s*\S*\/env\s+(-S\s+)?node(\s|$)/.test(head.split('\n')[0]);
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/** @param {{cliPath:string,serverUrl:string,run?:Function,signal?:AbortSignal,timeout?:number}} options */
export function createCli({ cliPath, serverUrl, run = exec, signal, timeout = 20000 }) {
  return async function cli(args, json = true) {
    const [file, fileArgs] = cliCommand(cliPath, args);
    const { stdout } = await run(file, fileArgs, {
      shell: false, timeout, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, BB_CLI: cliPath, BB_SERVER_URL: serverUrl, BB_THREAD_ID: '', BB_PROJECT_ID: '', NO_COLOR: '1' },
    });
    return json ? JSON.parse(stdout) : stdout;
  };
}
export function createReader(options) {
  const cli = createCli(options);
  const capabilities = createCapabilities({ cli });
  const projects = async () => {
    const data = await cli(['project','list','--json']);
    const rows = Array.isArray(data) ? data : data.projects;
    if (!Array.isArray(rows)) throw new Error('Unexpected BB project list response.');
    return rows.map(p => ({ id:p.id, name:p.name }));
  };
  return async function query(name, raw) {
    if (Object.hasOwn(capabilitySchemas, name)) {
      const value = await capabilities(name, raw);
      // Name what actually contributed, not the full set of things that might have.
      const source = { 'local-filesystem': 'BB CLI plus project roots read on this machine',
        'workspace-api': 'BB CLI plus the target workspace enumerated on its owning host',
        'index-only': 'BB CLI skill index only; the target workspace was not enumerated',
        'unavailable': 'Nothing was readable: both the BB CLI skill index and the target workspace failed for this environment',
      }[value?.coverage?.discovery] ?? 'BB CLI';
      return { checkedAt: new Date().toISOString(), source, ...value };
    }
    if (!Object.hasOwn(schemas, name)) throw new Error('Unknown BB read tool.');
    const args = schemas[name].parse(raw);
    let data;
    if (name === 'bb_projects') data = { projects: await projects() };
    if (name === 'bb_overview') {
      const [counts, names, listed] = await Promise.all([
        cli(['thread','count','--by','project','--json']), projects(), cli(['thread','list','--json']),
      ]);
      const rows = currentThreads(listed);
      data = { counts, projects: names, threads: rows.slice(0,20).map(threadSummary),
        returned: Math.min(rows.length,20), more: rows.length > 20,
        coverage: 'Current visible threads across all projects. Counts come from BB count. Listing may be bounded; use project filtering and search for missing work.' };
    }
    if (name === 'bb_threads') {
      const command = ['thread','list','--json'];
      if (args.projectId) command.push('--project', args.projectId);
      const rows = currentThreads(await cli(command)).filter(t => args.status === 'all'
        || (args.status === 'waiting' ? t.hasPendingInteraction : t.status === args.status));
      const page = rows.slice(args.offset,args.offset+40);
      data = { threads: page.map(threadSummary), nextOffset: args.offset+40 < rows.length ? args.offset+40 : null,
        coverage: 'Page of CLI listing; use bb_overview for authoritative counts.' };
    }
    if (name === 'bb_search') {
      // A leading hyphen is rejected so a spoken query cannot become a CLI flag.
      if (args.query.startsWith('-')) throw new Error('Search must begin with a word.');
      const found = await cli(['thread','search',args.query,'--limit','8','--json']);
      data = Object.fromEntries(Object.entries(found).map(([group, result]) => [group, {
        total: result.total, results: (result.results || []).map(r => ({ thread: threadSummary(r.thread),
          matches: (r.matches || []).slice(0,3).map(m => ({ sourceKind:m.sourceKind, text:m.text?.slice(0,800), sourceSeq:m.sourceSeq })) })),
      }]));
    }
    if (name === 'bb_read_thread') {
      const [state, conversation, interactions, queue] = await Promise.all([
        cli(['thread','show',args.threadId,'--json']),
        cli(['thread','log',args.threadId,'--format','minimal','--limit',String(args.turns)],false),
        cli(['thread','interactions','list',args.threadId,'--json']),
        cli(['thread','queue','list',args.threadId,'--json']),
      ]);
      // Prefer recent content if a single large turn exceeds the context budget.
      data = { thread: threadSummary(state.thread), pendingTodos: state.pendingTodos,
        conversation: conversation.slice(-10000), conversationTruncated: conversation.length > 10000,
        coverage: `Newest ${args.turns} user-message turns only; not complete history.`,
        interactions: short(interactions,3000), queue: short(queue,2000) };
    }
    return { checkedAt: new Date().toISOString(), source: 'BB CLI', ...data };
  };
}
