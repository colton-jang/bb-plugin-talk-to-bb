# Changelog

*Created: 2026-09-28*

Newest first. Releases are `vX.Y.Z` tags; a tag is never moved.

## 0.3.0 (2026-09-28)

### Ambient Walk (server side)

The server half of Ambient Walk: BB keeps you posted while your own music or podcast plays. The phone half lives in a
separate iOS client that calls these RPCs; nothing runs until it starts a walk. See [AMBIENT.md](AMBIENT.md).

- **Batched live check-ins.** No fixed schedule. When work finishes, BB waits briefly for anything else finishing at
  the same time and delivers it as one short check-in, at most one every 2 minutes. Urgent news (an agent you
  dispatched by voice replied or failed, an approval only you can give, a deadline inside the hour) can interrupt,
  with limits on how often. Quiet hours hold everything. Say yes to a check-in and BB opens a call on those items.
- **Hey BB calls.** Say "Hey BB" over your music for a short call. BB greets you first when you paused after the wake
  phrase, and the greeting gets shorter over a walk. Answers are kept short, with a one-line sign-off.
- **Per-walk memory.** Earlier Hey BB and check-in calls in the same walk carry into the next call as history.
- **Notes by voice.** "Thought bubble …" or "write this down" saves a private note that never becomes agent work.
  Ask BB to read your notes back, or to delete one: it names the note back and deletes it only after you confirm.
- New RPCs: `ambient` and `thought`.

### Notebook

- Every voice conversation is kept, whichever surface it came from: the panel, a phone walk, Hey BB calls and live
  check-ins. A walk stays one conversation across direct thread lines, reconnects and network drops.
- Transcripts name who spoke, including a thread's own title on a direct line; each conversation lists the actions
  it took and the notes captured in it.
- Read it in the panel (**Notebook** in the header, with a **Notes** tab to review and delete notes), or through the
  new `notebook` RPC (`list`, `get`).

### Backend settings

- `backendModel`, `backendReasoning` and `backendServiceTier` choose the model, reasoning effort and service tier
  behind every lookup and action. The fast tier is sent to GPT-Live as `priority`, the only name its delegation
  schema accepts.
- `phoneCallPrompt` (`lean`) gives phone calls a smaller tool set and a brief standing context.
- `backendStandingContext` (`full`, `brief`, `off`) controls how much of the operating context file reaches the
  backend.
- `probe-backend.mjs` benchmarks backend models offline, with every action stubbed.

### Lean lookups

- `lookupBudget` (`lean`) caps how much a thread read, the overview and search snippets hand to the voice backend,
  so long calls stay fast and cheap.
- Long threads can be paged: a thread read returns the newest part first and the assistant can read further back
  when a question needs it. This works on direct thread lines too.

### Logging

- Every lookup writes one timing line to the plugin log: model, effort, tier, time to the first tool call, each
  tool's run time, answer time and tokens.
- Voice faults are logged on the server.

### Also since 0.2.3

- **Standing operating context** (`operatingContextFile`): a file of your goals, rules, focus and boundaries, read at
  the start of every call as reference only. Live instructions and live BB threads always win over it.
- **Call opener** orients from current BB work, and an in-call ledger tracks what was parked, sent and in progress.
- **Call length and walk handoff** (`maxMinutes`, `walkHandoff`): at the limit a walk reconnects and continues
  instead of ending.
- **Responsiveness cues** (`cueProfile`: `off`, `subtle`, `steady`, `chatty`), including a soft device-side
  "still working" sound for `subtle`.
- **Direct thread line**: talk to one worker thread in its own voice, then return to the manager.
- **Network switches** (Wi-Fi to cellular) mid-call no longer leave a stuck session; the panel reconnects and the
  walk continues.
- An optional server-side Spotify pause for Hey BB calls (`spotifyClientId`) is experimental and off by default.

## 0.2.3

- Run a bb CLI that needs its own Node with the server's Node.
