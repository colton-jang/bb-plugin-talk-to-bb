Talk to your BB workspace out loud. A microphone in BB's sidebar opens a live voice conversation (OpenAI GPT-Live) that can look across every project and thread, bring a thread up in your browser, start an agent on a task, pass an instruction to an agent that's already working, or stop one. It keeps talking with you while the agents work, and tells you when they finish.

## What you get

**Answers grounded in BB.** Questions about current work go to BB before they're answered: thread status, search, recent conversations, pending approvals, and which skills and commands a project already has. It says "I read the thread" when it read it, and never claims a result it doesn't have.

**Actions with receipts.** Every start, send and stop is backed by a durable receipt that distinguishes sent, queued, uncertain and done. Actions need a quote from what you actually said in this call; text read out of a thread can never authorize one. Agents keep running after the call ends.

**Announces, then acts.** For everyday actions (starting an agent, messaging a thread, saving a note, looking something up) it says in one line what it is doing and does it; say "stop" or "cancel" to interrupt. It asks for an explicit yes only before anything outward-facing or hard to undo: email or messages to other people, public posts, deleting or archiving, spending money, permissions or credentials. When a thread you asked something answers during the call, it reads you the answer.

**Quiet review mode.** Say "just collect my comments" and it stops talking: each comment becomes a numbered note, agent actions are blocked, and agent updates are held until you're done. Acting on the notes takes an explicit request.

**Follow-through.** Things you park become recorded commitments, not promises it has to remember. Relative dates resolve in your time zone. A session is capped at twenty minutes, warns before the end, and the next call starts with a summary of what was left open.

**Screen sharing, opt in.** Share a tab or window and it can take one still snapshot when you refer to what's on screen, and hand that image to an agent.

## Requirements

bb 0.43 or later, and an OpenAI API key with GPT-Live access (voice is billed by OpenAI). Set your first name, preferred machine and any house rules for agent briefs in the plugin settings. The Pocket phone app's Walk mode uses this plugin.

## Safety

The assistant has no shell and no way to answer BB approvals or permission prompts; those stay with you. Agent briefs tell workers to draft rather than send email or messages. Raw audio and full conversations are not saved; only a short continuity record (your last words, open commitments, unconfirmed dispatches) is kept, and your last words reach the next call only if the call was cut off mid-request.
