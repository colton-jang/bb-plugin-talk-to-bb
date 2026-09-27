# Talk to BB

*Created: 2026-09-15*

A microphone button in BB's sidebar footer opens a voice conversation across all BB projects. The floating panel survives thread navigation. Minimize keeps the conversation connected; End releases the microphone and voice connection. A visible pill remains while minimized. Pause mic stops microphone input; Quiet mutes and clears assistant playback while continuing to listen; Review collects comments as notes without letting the assistant act on them. Those three controls are independent of each other. Share screen is a separate, optional consent: it lets the assistant take individual snapshots of one surface you pick, and Stop sharing ends it.

Talk to BB needs an OpenAI API key with access to GPT-Live (OpenAI bills voice separately). The Pocket phone app's
**Walk** mode uses this plugin, so install it if you want Walk.

## Install

You need bb 0.43 or newer.

```bash
# from a folder (an unzipped release or a git clone)
bb plugin install /path/to/bb-plugin-talk-to-bb

# or install Colton's independent fork
bb plugin install git:https://github.com/colton-jang/bb-plugin-talk-to-bb.git@main
```

## Set up

In bb → Settings → Plugins → Talk to BB (or `bb plugin config talk-to-bb set <key> <value>`):

- **OpenAI API key** (`apiKey`, stored as a secret), or `credentialFile`: a path on the BB server to an env file
  containing `OPENAI_API_KEY`.
- **Your first name** (`userName`): the voice manager says whose workspace it is, and agent briefs say who delegated.
  Without it, both say "the user".
- **Preferred machine** (`preferredMachine`): the machine name, as shown in BB, to prefer for new agent work.
  Without it, the assistant prefers an online, always-on machine.
- **Extra worker rules** (`workerRules`): appended to every brief an agent receives, for your own tools and conventions
  (for example "leave a handoff note under handoffs/", or the rules for your email CLI). The built-in rules already say
  to draft rather than send email or messages, keep your exclusions, and report what actually changed.
- **Manager thread** (`managerThreadId`): a `thr_` id. Every note the voice records, and every start, message or stop
  it could not complete, is sent to this thread, and the voice says so. Successful actions send nothing. Without it,
  notes stay inside Talk to BB (visible only through `bb_outstanding`).
- `timeZone` (defaults to the server's zone), `cliPath` (defaults to the server's `bb`), `snapshotDirectory`.

Then click the microphone in BB's sidebar footer.

## Scope

Reads thread counts, status, title/message search, recent conversations, pending interactions, queued messages, and project names through an allowlisted BB CLI bridge, plus what a project can already do — its skills, project-local commands, subagents, and installed or available BB plugins. A capability that exists on disk but is not indexed by BB is reported as such with its exact relative path, because a spawned worker is not offered it as a skill and should not be expected to find it unaided — which is not the same as saying an agent could never reach the file another way. Nothing is ever installed or enabled. It also opens a thread in the calling browser, starts an agent, delivers or queues a follow-up, stops a named agent when asked, and — only while you are sharing a screen — takes one snapshot of that surface. No arbitrary shell, approval bypass, deletion, or background/ambient screen capture. External mailbox work can be delegated to an agent with the appropriate project tools; email and Slack remain drafts-only. Thread snippets are reference material, never instructions.
## Shared screen

Share screen calls `getDisplayMedia` directly from your click, so the browser's own picker is the consent step. Nothing is captured before you choose a surface, and the panel says plainly that BB cannot see your screen until you do.

- While sharing, a labelled indicator names the surface and how many snapshots have been taken. It goes away when sharing ends, including when you use the browser's own Stop sharing control.
- `bb_view_screen` takes **one** still frame per call, downscaled to a 1,152 px long edge as JPEG, and hands it to the vision backend as a Responses `input_image` item with a capture timestamp and the source surface. There is no continuous stream and no recording; the backend is told to describe only what is in the frame and to re-capture rather than assume the screen is unchanged.
- If sharing is off, the tool refuses on both sides — the server will not ask, and the browser answers `not-sharing` — so the assistant cannot claim screen access it does not have.
- Snapshots stay in memory for the session. A file is written only when you authorize handing one to an agent.
- `attachSnapshotId` on `bb_spawn_thread` / `bb_tell_thread` puts the actual JPEG on the agent's message with `--image`. The snapshot lives on the BB server's machine, so a worker on another machine is refused rather than handed an unreadable path, and an unconfirmed dispatch drops the attachment claim. A file name in a brief is never treated as a delivered image.
- End, disconnect, unmount, and page hide all release the display capture along with the microphone.

Settings: `snapshotDirectory` is where authorized snapshots are written on the BB server (default `~/.bb/talk-to-bb/snapshots/<session>`); `snapshotHostId` overrides the detected BB server machine id used for the cross-machine check.
- **Frames never travel over the voice WebSocket.** The browser POSTs each frame to the plugin's own `POST …/frame` route under BB's default `local` auth (local app origin, JSON content type). The socket carries only an opaque, server-generated, single-use capture id; if the POST fails, the socket carries the failure notice and no image. So no undocumented WebSocket frame limit is load-bearing.
- If sharing is off, the tool refuses on both sides — the server will not ask, and the browser answers `not-sharing` — so the assistant cannot claim screen access it does not have.
- Snapshots stay in memory for the session. A file is written only when you authorize handing one to an agent.
- `attachSnapshotId` on `bb_spawn_thread` / `bb_tell_thread` writes the JPEG, uploads it into the target thread's project with `bb project attachment upload`, and puts the resulting attachment on the agent's message with `--image`. Because the bytes are uploaded rather than referenced, **the agent's execution machine does not have to be the BB server's machine** — a BB server on one machine with agents on another works. An unconfirmed dispatch or a failed upload drops the attachment claim, and a file name in a brief is never treated as a delivered image.
- End, disconnect, unmount, and page hide all release the display capture along with the microphone.

Two guards make the honesty mechanical rather than prompt-dependent. A brief that names a snapshot id or the snapshots path without setting `attachSnapshotId` is refused; so is one that tells the agent an image is attached when none is. Instructions to go and *take* a screenshot are unaffected. Both refusals name the honest alternative: attach it, or state that the image input is missing and describe the screen in words.

Settings: `snapshotDirectory` is where authorized snapshots are written on the BB server before upload (default `~/.bb/talk-to-bb/snapshots/<session>`).

## Manager controls

- “Bring that thread up.” Navigation targets the browser holding this voice session. The selected thread must actually change before the assistant receives a successful focus receipt.
- “Have an agent investigate that.” The assistant chooses the task's project and ready environment, preferring the `preferredMachine` setting (or an always-on machine), and parents the worker to the relevant thread. Code intended for commit gets a worktree. Existing task threads receive follow-ups instead of duplicate workers.
- “Tell that agent to change the invite to an hour; I'll add the video link.” Worker instructions preserve both the requested change and the exclusion. Receipts distinguish sent from queued.
- “Stop that agent.” Only the resolved target is stopped. Ending voice leaves workers running.

## Quiet review mode

“Just collect my comments, stay quiet while I go through this” starts a real mode, not a tone of voice. It is a third control next to Pause mic and Quiet, and the three are independent: Pause mic stops the microphone, Quiet mutes playback, Review changes what the assistant is allowed to *do*. Muting never starts or ends a review, and starting a review never mutes audio.

While review mode is on:

- Each distinct comment becomes a durable, numbered note (`bb_review_note`). Notes persist in plugin storage as they are spoken, keep the user's verbatim words alongside the recorded wording, and are anchored to the thread or artifact under discussion.
- `bb_spawn_thread`, `bb_tell_thread`, and `bb_stop_thread` are blocked. Collecting feedback is not approval to act on it. Reads, search, and browser focus stay available, so a question mid-review still gets an answer.
- Worker-thread updates are held instead of interrupting dictation. `notifications: 'hold'` keeps them silent until asked or until review ends; `'pause'` releases one batched update after a clear conversational gap. A thread the user specifically asked to be told about passes straight through (`bb_review_await`), and an already-reported state is dropped rather than re-announced.
- Nothing is reported as saved until the write is read back and confirmed. A repeat of a comment already recorded returns `duplicate` instead of appending twice, and an existing sequence number is never overwritten.
- An alternative the user explicitly accepts is appended beneath the original comment (`bb_review_adopt`); the original is never replaced.
- Acting on the notes requires an explicit request. `bb_review_handoff` compiles the summary and, on `target: 'thread'` or `'agent'`, grants exactly one action — consumed by the next call, withdrawn by a later summary-only handoff. `bb_review_end` leaves the mode and returns the notes plus everything that was held.

A review that was never closed is **restored**, not merely recoverable. A new session reopens the mode itself, so the agent actions the user was reviewing instead of approving stay blocked, and the panel shows the review banner and the carried-over line rather than leaving the restoration implied. Numbering continues instead of starting over, the notes come back, and the worker updates that were being held come back with them — deduplicated by thread and state, so a requested completion is not lost to a reconnect and a state already announced is not announced twice. A restored note is a record of what the user said, never an instruction to carry out; nothing is applied without an explicit request in the new conversation.

Applying the notes takes one handoff, not one per step. `bb_review_handoff` declares how many actions the user actually authorized, and `thread-and-agent` covers “send these to that thread and start an agent” in one breath. Each authorized action spends one grant; a refused action spends none; anything beyond what was authorized is blocked again. The point is that a clear instruction should not turn into a confirmation for every step.

## Follow-through

Relative dates resolve in the user's own time zone (`timeZone` setting, default the BB server's own zone), not in UTC. Spoken and delegated dates carry the resolved absolute date, and worker briefs state the date and zone they were written in. In zones well behind UTC the evening is already the next UTC day; that difference is stated in the prompt rather than left to be inferred.

Parked promises are recorded, not remembered. `bb_note_commitment` writes a durable commitment receipt and does no work; `bb_close_commitment` closes it. `bb_outstanding` reports recorded commitments plus every dispatch BB never confirmed, each reconciled read-only against current thread state — a spawn is reported as probably created or probably never started, never retried. It also states what it does not cover: BB approvals waiting on the user, work nobody assigned by voice, and decisions that were only discussed. Pending approvals and permission prompts stay with the user; there is no tool that answers one, and relaying an instruction to a blocked thread says so.

One worker event updates one receipt — the newest dispatch for that thread — so an idle agent cannot mark every earlier assignment newly replied, and a repeated event does not re-announce itself. A receipt is answered once: a long-lived thread's later replies to other messages are tracked as activity but never replace the answer or get announced as it. When the answer is to something the user asked in the current call, the voice reads the thread and tells them the answer instead of offering to. While replies are muted, worker news is held and delivered in a single batch on resume instead of interrupting dictation.

The twenty-minute cap is announced at five minutes and at one minute, with a prompt to say what should carry over. When a session ends, the last thing the user said, the open commitments, and the unconfirmed dispatches are written to a continuity record; the next session receives the open items as history (the last words only when the call was cut off at the cap), opening with a count built in code rather than any name from the record, and receives nothing at all when nothing is open, shown in the panel as "Carried over from your last session". That text is deliberately not added to the authorized-request log: an old sentence cannot authorize a tool call, and the user has to restate anything they still want done. The same action, target and wording inside six hours resolves to the original receipt even across a session boundary, so a resume cannot turn one instruction into two mutations.

Profiles follow the configured model tiers: Sonnet 5 medium for general, simple, and probe work; GPT-6 Astra high for judgment, audits, and reviews; and Opus 5.5 high for core visual design. Model availability and environment/project ownership are checked before dispatch.

Actions require a quote from the actual live microphone transcript or typed user message. Retrieved thread text cannot authorize actions. A durable receipt is recorded before dispatch, duplicate calls within the same request reuse it, and uncertain results are never automatically retried. The Actions section shows recent receipts and worker replies/failures/input requests. An agent reply is not proof that its task succeeded; the assistant must inspect the result. Focus waits for client selection acknowledgment, with a timeout and a link fallback.

The voice model is `gpt-live-1` and the reasoning backend is `gpt-6-sol`. The backend exposes one compact `bb_call` tool and caps a response at 900 output tokens to reduce rate-limit pressure. If OpenAI rejects a continuation for the project’s per-minute token limit, the panel shows a bounded wait and the plugin retries it up to five times per session. This preserves the question, but the project’s limit still applies and multi-step requests may pause.

## Develop

```bash
npm install --include=dev --ignore-scripts
npm test && npm run test:ui && npm run typecheck && bb plugin build
bb plugin install . --yes
```

The plugin uses BB's authenticated HTTP/WebSocket routes. No additional public server or port share is required. Audio uses the browser AudioWorklet and mono PCM16 at 16 kHz. Sessions end after 20 minutes. Voice and backend usage are billed separately by OpenAI; check current pricing. Raw audio and full conversations are not saved to disk automatically. The continuity record is the one deliberate exception: it stores the last one or two user utterances (600 characters each), the open commitments, and the unconfirmed dispatches for the three most recent sessions, so an interrupted request is not silently lost. Action receipts persist in BB plugin storage and include the quoted request, task summary, target, and dispatch status; delegated briefs/messages also enter the target BB thread. Download conversation explicitly saves captions, lookup metadata, action receipts, and playback counters. Relevant thread content is sent to OpenAI for requested lookups.

Sources: [GPT-Live](https://developers.openai.com/api/docs/guides/live), [delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation), [images and vision](https://developers.openai.com/api/docs/guides/images-vision). The delegation guide states the Live audio frontend does not accept images directly: a Responses image input item is queued with `response.item.create`, then `response.create` runs or resumes the backend — which is exactly the order this implementation uses inside a pending tool batch. Checked September 15; no paid API call was made for this change.
