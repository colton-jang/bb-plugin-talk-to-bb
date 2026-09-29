// Created: 2026-09-27. What BB says the instant it hears "Hey BB", before the call is live. It gets shorter
// over one Ambient run: first an overview and a question, then "Hey, what's up?", then just "Hey." Pocket
// prefetches the next one so it plays at once, and only when the user paused after the wake phrase.

/** A thread title said aloud: no parentheticals, no "project: " prefixes read as punctuation, short. */
export function spokenTitle(title) {
  const clean = String(title || '').replace(/\([^)]*\)/g, ' ').replace(/[`*_#]/g, '').replace(/\s*:\s*/g, ', ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  return words.length > 7 ? `${words.slice(0, 7).join(' ')}…` : clean;
}

/** @param {{calls:number, threads?:any[]|null}} input  threads: currentThreads() rows, or null if unreadable */
export function ackText({ calls, threads = null }) {
  if (calls >= 3) return { tier: 'short', text: 'Hey.' };
  if (calls >= 1) return { tier: 'casual', text: "Hey, what's up?" };
  if (!Array.isArray(threads)) return { tier: 'casual', text: "Hey, what's up?" };
  const waiting = threads.filter(t => t.hasPendingInteraction);
  const running = threads.filter(t => !t.hasPendingInteraction && ['active', 'starting'].includes(t.status));
  const parts = [];
  if (waiting.length) parts.push(`${waiting.length === 1 ? 'one thread needs' : `${waiting.length} threads need`} you: ${waiting.slice(0, 2).map(t => spokenTitle(t.title)).join(', and ')}`);
  if (running.length) parts.push(`${running.length === 1 ? 'one is' : `${running.length} are`} running${waiting.length ? '' : `: ${running.slice(0, 2).map(t => spokenTitle(t.title)).join(', and ')}`}`);
  if (!parts.length) return { tier: 'overview', text: 'Hey. Nothing is running right now. What do you want to work on?' };
  return { tier: 'overview', text: `Hey. ${parts.join('; ')}. What do you want to work on?` };
}
