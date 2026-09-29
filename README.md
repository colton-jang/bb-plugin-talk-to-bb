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
- `cueProfile`: short spoken signs of life while a lookup or dispatch runs — `off` (default), `subtle`, `steady`
  or `chatty`. See [Responsiveness cues](#responsiveness-cues).
- **Backend model** (`backendModel`, default `gpt-6-sol` in this fork; Chaning recommends `gpt-6-luna` for speed and cost; `backendReasoning`: empty = the model's default, or
  `none`, `low`, `medium`, `high`; `backendServiceTier`: empty, `auto`, `default`, `flex` or `fast`): the Responses
  model behind every lookup and action. GPT-Live's delegation schema only accepts the older name for the fast tier, so
  `fast` is sent as `priority`. Every lookup writes one `backend lookup …` line to the plugin log with the
  model, time to first tool call, each tool's run time, model vs tool time, and tokens including cache writes.
  Voice faults are logged too (`voice fault: …`). `probe-backend.mjs` benchmarks models offline (read tools real,
  every action stubbed).
- `backendStandingContext` (`full` default, `brief`, `off`): how much of the operating context file goes into the
  backend prompt. `phoneCallPrompt` (`full` default, `lean`): for Hey BB and check-in calls, `lean` drops the screen,
  focus, review, direct-line and capability tools and uses the brief context (about 5.5k instead of 8.1k prompt tokens).
- `operatingContextFile` (empty = off): a text file on the BB server with your standing context (goals, decision rules,
  current focus, boundaries, optional background snapshots). It is read at the start of every call as reference only;
  live instructions and live BB threads always take precedence over it.
- `lookupBudget` (`full` default, `lean`): how much a thread read, the overview and search snippets hand to the voice
  backend. Everything a lookup returns stays in the backend's memory for the rest of the call, so `lean` keeps long
  calls fast and cheap. A thread read returns the newest part first; the assistant can page further back
  (`olderBy` / `nextOlderBy`) when a question needs earlier history.
- `maxMinutes` (default 20, 5–60) and `walkHandoff` (`on` default): the length of one voice connection, and whether the
  call reconnects and continues at the limit. See [Follow-through](#follow-through).
- `spotifyClientId`, `spotifyRedirectUri`: an optional, experimental server-side Spotify pause for phone "Hey BB" calls.
  Off unless you set a client ID; leave it empty unless you are testing it.

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

## Direct thread line

“Let me talk directly to the Pocket thread” hands the call to that ONE thread, in a different voice (the manager speaks as `marin`; a thread line speaks as `cedar`), so it is always clear who is answering. From the panel, open the thread in BB and press **Talk to this thread**. “Take me back to the manager” (or **Back to manager**) returns you.

- One leg at a time. The plugin holds a single voice reservation and the browser or phone has one microphone, and a GPT-Live voice is fixed when a session starts. So the switch ends the manager's session and opens a new one on the same browser connection: the mic, the reservation and the panel stay put, and nothing else can start a call in between.
- The thread line can read that thread, send its agent an instruction (steer or queue), and check what was already sent to it. Its tools take no thread id, so it cannot reach another thread, and it cannot start, stop or focus agents or look at the screen. Instructions follow the manager's rules: an exact quote from the live conversation, a receipt written before dispatch, drafts-only email and Slack. The sentence you used to ask for the line counts as live speech, so “…and tell it the checklist comes first” is not lost in the switch.
- Each switch carries one short handoff (under 500 tokens) each way: what you asked for going in, and on the way back what you said, what was sent (from receipts) and any updates from other threads that were held. The returning manager treats it as history, not authorization, and skips the call opener.
- Review mode must be off to open a line, because a line would bypass the review gate. End during a line ends the call. A line that fails or reaches its fifteen-minute limit brings the manager back. Source: `direct-worker.mjs`; `node probe-direct-worker.mjs <thr_id>` runs one short, read-only cedar session against a thread without touching the plugin route.

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

**Network switches (Wi-Fi → 5G) mid-call (2026-09-27).** A phone that changes networks usually leaves the old socket half-open: the server never sees it close. Before this fix the one-call lock and the GPT-Live session (still billing) outlived the call, and the next start was refused with "a session is already open". Now:
- **Liveness is judged from traffic.** The SDK socket has no ping, so the server counts audio frames (every 20 ms) and a panel `ping` every 5 s. A new start may **take over** a holder that has been silent for 5 s. It closes that call as `network-lost` and continues its walk. A holder that is still streaming is a genuinely live call elsewhere and is refused ("already live in another tab or device").
- **A socket that closes without End** is also `network-lost`: the lock is released as soon as the provider confirms (forced after 5 s), and a handoff is saved.
- **The next start within 10 minutes continues that walk automatically:** the same ledger and last-words handoff as the limit handoff. End is always a real ending.
- **Orphan cleanup:** a call silent for 45 s is ended even if nobody reconnects, so a dead call stops billing. The window is generous in case a native client goes quiet while its mic is paused.
- **Only one takeover runs at a time,** so two reconnects racing after a drop yield exactly one call.
- **The browser panel** treats a socket that dies after the call went live as a drop, not an end. It shows "Connection lost. Reconnecting…", retries at 2, 4, 8 and 15 s (a refusal during the takeover window counts as a retry), retries at once on the browser's `online` event, and then offers one **Reconnect** button. The transcript stays on screen.
- **Native Pocket Walk** needs the same client behavior (reconnect on an unexpected close, and a 5 s ping). The server side already continues the walk for any client that simply starts again.

Safe live test (only when no call is active: `bb plugin rpc call talk-to-bb status` shows `active:false`). Start a walk on the phone on Wi-Fi, say one sentence, then turn Wi-Fi off. Within about 5–15 s the panel should say "Connection lost. Reconnecting…" and come back with "I'm back…", and `status` should never stick at `active:true` with no call running. Then press End and start again: that call must start fresh, with no continuation.

**Call length and the walk handoff (2026-09-27).** Each connection lasts `maxMinutes` (setting, default 20, clamped to 5–60). GPT-Live's documentation (checked 2026-09-27) publishes no numeric session maximum; it documents only that a session can end with `session.closed` reason `expired`. 60 minutes is therefore an assumed ceiling, taken from the sibling Realtime API's documented limit, not a published GPT-Live figure. A provider expiry that arrives before our own timer is recorded as `provider-expired` and handled like our own limit. With `walkHandoff` on (the default), the limit does not end the walk. The server saves a single-use handoff token (valid 10 minutes, spent only once the next connection is live) holding this walk's ledger (parked / sent / in progress, from receipts only) and the user's last few words. The panel reconnects by itself, and the new connection resumes ("I'm back…") without the opener and without any earlier walk's content. The reconnect is a new provider session because GPT-Live's only resume primitive, fork, requires `store: true` recordings, which this plugin deliberately does not keep. Expect a pause of a few seconds while the microphone and connection are re-acquired. If the automatic reconnect fails (a mobile browser that will not restart audio without a tap, a network drop), the panel shows one **Continue walk** button that retries with the same token. Past the token's 10 minutes, the next call starts fresh with the usual continuity summary. With `walkHandoff` off, the cap is announced at five minutes and at one minute, with a prompt to say what should carry over. When a session ends, the last thing the user said, the open commitments, and the unconfirmed dispatches are written to a continuity record; the next session receives the open items as history (the last words only when the call was cut off at the cap), opening with a count built in code rather than any name from the record, and receives nothing at all when nothing is open, shown in the panel as "Carried over from your last session". That text is deliberately not added to the authorized-request log: an old sentence cannot authorize a tool call, and the user has to restate anything they still want done. The same action, target and wording inside six hours resolves to the original receipt even across a session boundary, so a resume cannot turn one instruction into two mutations.

Profiles follow the configured model tiers: Sonnet 5 medium for general, simple, and probe work; GPT-6 Astra high for judgment, audits, and reviews; and Opus 5.5 high for core visual design. Model availability and environment/project ownership are checked before dispatch.

Actions require a quote from the actual live microphone transcript or typed user message. Retrieved thread text cannot authorize actions. A durable receipt is recorded before dispatch, duplicate calls within the same request reuse it, and uncertain results are never automatically retried. The Actions section shows recent receipts and worker replies/failures/input requests. An agent reply is not proof that its task succeeded; the assistant must inspect the result. Focus waits for client selection acknowledgment, with a timeout and a link fallback.

The voice model is `gpt-live-1`. In this fork the reasoning backend defaults to `gpt-6-sol` (`backendModel` changes it). The backend exposes one compact `bb_call` tool and caps a response at 900 output tokens to reduce rate-limit pressure. If OpenAI rejects a continuation for the project’s per-minute token limit, the panel shows a bounded wait and the plugin retries it up to five times per session. This preserves the question, but the project’s limit still applies and multi-step requests may pause.

## Ambient Walk (phone)

The server side of Ambient Walk ships in this plugin; the phone side lives in a separate iOS client (Pocket) that
calls it. Nothing runs until that client starts a walk. The design notes and the full RPC table are in
[AMBIENT.md](AMBIENT.md).

- **Live check-ins.** While your own music or podcast plays, finished work is batched: when news arrives the server
  waits about 30 seconds for anything else finishing, then delivers one short check-in, at most one every 2 minutes.
  Urgent news (an agent you dispatched by voice replied or failed, an approval only you can give, a deadline inside
  the hour) can interrupt, within limits. Quiet hours (22:00–07:00 in the `timeZone` setting) hold everything.
  If you answer yes to a check-in, BB opens a call on those items.
- **Hey BB calls.** Saying "Hey BB" over your music opens a short call. BB greets you first if you paused after the
  wake phrase, and the greeting gets shorter over a walk ("Hey, what's up?", then just "Hey.").
- **Per-walk memory.** Earlier Hey BB and check-in calls in the same walk ride into the next call as history, sized to
  stay small.
- **Notes by voice.** "Thought bubble …" or "write this down" saves a private note. Notes never become agent work,
  receipts or briefs. You can ask BB to read your notes back, and to delete one: it finds it, names it back and deletes
  it only after you confirm.

RPCs: `ambient` (`start`, `stop`, `status`, `poll`, `flush`, `ack`, `deadline`), `thought` (`capture`, `list`, `delete`) and
`notebook` (below).

## Notebook

Every voice conversation is kept, whichever surface it came from: the panel, Pocket's Walk, "Hey BB" calls and live check-ins. Press **Notebook** in the panel header to read them back: newest first, grouped by day, each one expandable to its transcript and the actions it took (click one to open its thread). A walk stays one conversation through everything that happens in it: a direct line to a thread and back, a reconnect at the time limit, a network drop. On a direct line the thread speaks under its own title (click it to open the thread) rather than as BB, and the line itself is listed with the actions. The duration is the whole walk, first word to last.

The **Notes** tab lists every note you captured, newest first, with Delete (it asks first). In a call you can also ask BB to delete a note: it finds it, names it back, and deletes it only after you say yes. Deleting a note also removes its words from any transcript it was dictated in.

Retention: the last 200 conversations or 30 days, whichever is smaller, and about 160 KB of text per conversation. The notebook is stored in the plugin's kv on the BB server. Nothing in it is read by agents, briefs, digests, resume briefings or `bb_outstanding`. Pocket can read it through the `notebook` rpc (`list`, `get`). In `get`, every turn has `speaker` (`you`, `bb` or `thread`) and `label` (`You`, `BB`, or the thread's title); a thread turn also has `threadId` and `link` (`@thread:<id>`). A direct line appears in `actions` as `kind: 'worker-line'` with `status` `opened`, `returned` or `ended`. `seconds` is wall time from the first leg's start to the last leg's end, and `legs` counts voice sessions (manager, direct lines, reconnects).

## Responsiveness cues

A few seconds of dead air while BB is looking something up is enough to make you wonder whether the assistant is still
on it. `cueProfile` is an experiment in filling that gap the way a person would: a brief acknowledgement, then a rare
"still on it", timed to the silence you actually hear. It is `off` by default, so nothing changes until you pick a profile.

Silence is counted from the last thing you heard (the assistant's playback, your own speech, or the previous cue), while
the backend is working: from the moment it starts on your request (reasoning, or writing a long dispatch brief) through
every tool call, until it answers. Each number is seconds of that silence before the cue:

| Profile | Acknowledgement | First progress cue | Then | Most per wait |
|---|---|---|---|---|
| `off` | — | — | — | 0 |
| `subtle` | soft sound from 2.5 s (no words) | 8 s, spoken once | the sound continues quietly | 1 spoken |
| `steady` | 2 s | 7 s | every 15 s | 4 |
| `chatty` | 1.5 s | 6 s | every 10 s | 6 |

- The acknowledgement is skipped when the tool returns first, and when the assistant already said something after the
  call started (it acknowledged on its own), in which case the first cue is a progress cue.
- The moment the last pending call returns, nothing more is said about it. Each cue also tells the model to skip it if
  the result has already arrived or you are talking.
- Cues name the actual state: looking something up in BB, waiting for a snapshot or for the browser to switch, starting
  an agent or delivering a message (not confirmed yet), relaying to an agent that is still busy, or messaging a thread
  that is blocked on an approval only you can give. "Busy" and "blocked" come from the thread's state in an earlier
  lookup in the same call. The wording never says or implies that anything is done, found, sent or started.
- Example phrasings rotate so consecutive cues differ; filler sounds ("mm", "uh-huh") are ruled out.
- Quiet, review mode, and a closed session hold the voice cue entirely, and none is due while the assistant or you are
  speaking. Review-note tools never cue. The panel's status line still shows a visual cue (e.g. "Starting the agent (not
  confirmed yet) · 8s"), because that talks over nobody.
- A spoken cue is one `session.commentary.append`, well under the 500-token append limit (tests pin every variant
  under 1,800 characters).
- **The soft sound (`subtle`, 2026-09-27)** is played by the panel (`earcon.mjs`), never by the voice model: GPT-Live is a
  speech model with no documented non-speech sounds. The server sends `working` on/off (`cues.mjs` `onEarcon`). The panel
  synthesizes quiet, slightly varied bubbles (peak gain 0.03, one per ~0.65 s), stops the instant the manager speaks, you
  speak, Quiet is on, review is on or the call ends, and waits 0.5 s before stopping when work goes idle so it does not
  hiccup between a tool and the backend's next thought. Native Pocket Walk needs its own player for `working` events.
- **Measured on a real session (2026-09-27):** GPT-Live streams output audio continuously, about 32 KB/s of digital
  silence while the backend works. Counting those bytes as speech kept every profile silent in real calls; only audible
  samples (`isAudible`, peak > 256) count as speech now. A real run: quick spoken "let me check", then the sound from
  2.5 s into the silence straight through two lookups, one spoken check-in at 8 s of silence, sound off when the answer
  began.

Try it, once the plugin has been reloaded outside a live call:

```bash
bb plugin config talk-to-bb set cueProfile subtle   # then steady / chatty; off to stop
```

The profile is read when a call starts, so change it between calls. Source: `cues.mjs`; tests: `test/cues.test.mjs`.

## Develop

```bash
npm install --include=dev --ignore-scripts
npm test && npm run test:ui && npm run typecheck && bb plugin build
bb plugin install . --yes
```

The plugin uses BB's authenticated HTTP/WebSocket routes. No additional public server or port share is required. Audio uses the browser AudioWorklet and mono PCM16 at 16 kHz. Connections last `maxMinutes` (default 20, at most 60) and hand off to a new connection at the limit (see above). Voice and backend usage are billed separately by OpenAI; check current pricing. Raw audio and full conversations are not saved to disk automatically. The continuity record is the one deliberate exception: it stores the last one or two user utterances (600 characters each), the open commitments, and the unconfirmed dispatches for the three most recent sessions, so an interrupted request is not silently lost. Action receipts persist in BB plugin storage and include the quoted request, task summary, target, and dispatch status; delegated briefs/messages also enter the target BB thread. Download conversation explicitly saves captions, lookup metadata, action receipts, and playback counters. Relevant thread content is sent to OpenAI for requested lookups.

Sources: [GPT-Live](https://developers.openai.com/api/docs/guides/live), [delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation), [images and vision](https://developers.openai.com/api/docs/guides/images-vision). The delegation guide states the Live audio frontend does not accept images directly: a Responses image input item is queued with `response.item.create`, then `response.create` runs or resumes the backend — which is exactly the order this implementation uses inside a pending tool batch. Checked September 15; no paid API call was made for this change.
