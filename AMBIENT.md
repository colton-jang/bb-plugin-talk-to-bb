# Ambient Walk and thought bubble

*Created: 2026-09-27*

**Status:** the server side ships in this plugin (the `ambient`, `thought` and `notebook` RPCs, live check-ins and Hey BB calls). The phone side (Walk, Siri capture, notifications) lives in a separate iOS client (Pocket) that calls these RPCs. Nothing runs until that client calls `ambient` with `start`. Thought capture works whenever the RPC is called.

## What iOS allows

These are the facts that decide the design. The sources are listed at the end.

1. **The mic can only start in the foreground.** A background app can't start a mixable recording (`cannotStartRecording`) [A6]. It also can't activate a non-mixable session (`cannotInterruptOthers`) [A7][F1]. So a wake phrase only works if Pocket opened the mic in the foreground at Start Walk and kept it open the whole walk.
2. **Keeping the mic open next to Spotify costs music quality on AirPods.** Spotify keeps playing only with `.playAndRecord` + `.mixWithOthers` [A2]; today's Walk session isn't mixable, so it interrupts Spotify. The AirPods mic uses the Bluetooth hands-free profile (HFP), which the system prefers over the stereo music profile (A2DP), and that switches the output to HFP too [A10][A11]. Music then plays at phone-call quality [S1]. There are two ways around it:
   - A2DP only, which means using the iPhone's own mic. That mic is muffled in a pocket [F3].
   - iOS 26 `.bluetoothHighQualityRecording`. Its limits:
     - It needs AirPods 4 or AirPods Pro 2 [S2].
     - It's not available in the EU.
     - It turns off `.voiceChat` echo cancellation.
     - Apple says it "isn't recommended for real-time communication" [A12][W1].
3. **Spotify may not come back on its own.** `.notifyOthersOnDeactivation` / `.shouldResume` is only a hint to the other app [A13][A14]. Apple Music and Podcasts resume; Spotify has been reported not to [F4][S3].
4. **There's no wake-word API for third-party apps.** "Hey Siri" belongs to the system. On-device speech is possible with iOS 26 `SpeechAnalyzer`/`SpeechDetector` [A18][A19] or a library like Porcupine [S4]. Nobody has published credible battery figures. The mic indicator stays on the whole time [A15]. App Review requires consent and a visible recording indicator, and requires disclosure of third-party AI (2.5.14, 5.1.2) [R1].
5. **Siri is the capture path that needs no mic from Pocket.**
   - A trigger phrase can't contain free text, but a value prompt can collect it ("What's the thought?") [W3]. Siri records the audio itself; the existing `TellBBIntent` already works this way.
   - Control Center, Lock Screen and Action Button buttons can run an intent [A20][A22].
   - `AudioRecordingIntent` (iOS 18) needs a Live Activity. It has been reported to fail with "Target is not foreground" when started cold from the background [A23][F5].
   - A third-party app can't get AirPods stem presses while Spotify is the Now Playing app [A24][W4].
6. **Siri can read digests aloud with no audio code.** Announce Notifications reads notifications from third-party apps on AirPods while the phone is locked [N1]. Since iOS 15, any app's notifications can be announced. Communication and Time Sensitive notifications are announced by default [N2]. Whether announcements duck Spotify, and whether it resumes afterwards, isn't documented. Test it on a phone.

## The modes

### 1. Ambient digest (no mic)

Spotify stays in charge of audio. The server batches BB news. Pocket's server-side notifier polls the `ambient` RPC every 20 seconds, which it already does for its own notifications. It pushes what comes back, and Siri reads it on AirPods.

**Batching** (`AmbientBatcher`):
- There's no fixed slot. When news arrives, the batcher waits 30 seconds for anything else finishing at the same time, then delivers it as one digest. Digests are at least 2 minutes apart, and nothing new means nothing is said.
- A digest reads at most 5 items, in this order: needs you, failed, deadline, replied. It counts the rest ("and 3 more when you look").
- Each thread appears once and its latest state wins. A thread stays marked as one you're waiting on even if its state changes.
- A digest never lands within 90 seconds after an interruption. When one is due, it carries any urgent news too, so you hear one message rather than two.

**Urgent** (interrupts between digests):
- An agent you are waiting on replied or failed. "Waiting on" means you dispatched it by voice, so it has a receipt.
- A BB approval or question that only you can answer.
- A deadline inside the next hour, or one missed by less than 15 minutes. Deadlines come in through `ambient {op:"deadline"}`.

**Interruption limits:**
- A burst of urgent news is merged into one message: the batcher waits until nothing new has arrived for 8 seconds, but never more than 32.
- Interruptions are at least 90 seconds apart.
- At most 4 per 30 minutes. After that, urgent news waits for the next digest.

**Dedupe:**
- Each piece of news is identified by its state plus the thread's `updatedAt`. The same event delivered twice is spoken once; a second reply is new news.
- If a live call already said it, it's marked as spoken.
- Anything handed out and never acknowledged comes back after 2 minutes. `ack {spoken:false}` brings it back straight away.
- State is saved in plugin kv, so a reload doesn't repeat news or lose it.

**Quiet hours:**
- 22:00–07:00 in the plugin's time zone, set per walk.
- Everything is held during quiet hours, urgent news included.
- A walk ends by itself after 3 hours. Stopping a walk drops the held news; Pocket still shows all of it.

### 2. Thought bubble (user-initiated, music keeps playing)

1. You say "Hey Siri, Pocket thought" (or press the Action Button, Control Center or Lock Screen control).
2. Siri asks "What's the thought?", you dictate it, and Pocket calls `thought {op:"capture"}`.
3. Siri says "Got it." Pocket never touches the audio session.

In a live Walk, saying "thought bubble …" or "Manager, write this down" makes the model call `bb_capture_thought`. That tool needs a quote from your own speech, and the model says only "Got it."

**Storage:** plugin kv (`bb.db` on the BB server), one key per thought (`thought:<iso>:<id>`).
- Why kv:
  - It's durable and is what the plugin already uses for receipts.
  - It's outside every git working tree.
  - Scheduled jobs and dashboards that read the repo never see it.
  - It works for anyone who installs this public plugin; a path into one person's repo would not.
- Each save is read back and compared before it's confirmed.
- A `clientId` makes Siri retries idempotent.

**Personal by default:**
- Thoughts aren't `action:*` receipts, so they never reach `bb_outstanding`, resume briefings or worker briefs.
- The turn you dictated is blanked out of the continuity record.
- The digest can't read thoughts.
- The only ways to read them are `thought {op:"list"}`, the panel's Notebook, and `bb_recall_thoughts` when you ask in a call.

**Deleting a note:** the Notebook's Notes tab has Delete (it asks first), Pocket can call `thought {op:"delete", id}`, and in a call you can ask BB to delete one. By voice, BB must find it with `bb_recall_thoughts`, name it back in a few words, and call `bb_forget_thought` only with your confirmation from after that, quoted from this call. A delete removes the record, its Siri retry index, and the words you dictated in any notebook transcript. Deleting an already-deleted note reports `deleted:false`, not an error.

### 3. Always listening: experimental only

Pocket starts Walk in the foreground and keeps one mixable `.playAndRecord` session open, with the wake phrase detected on the phone. This is the only way to interrupt the music by voice. It costs music quality on AirPods (or needs iOS 26 high-quality recording) and keeps the mic indicator on. Treat it as an on-device experiment behind a setting, not the default.

## RPCs (`/api/v1/plugins/talk-to-bb/rpc/<method>`)

| Method | Input | Result |
|---|---|---|
| `thought` | `{op:"capture", text, capturedVia:"siri"\|"action-button"\|"control"\|"walk"\|"voice"\|"app", clientId?, capturedAt?}` | `{thought:{id,text,at,…}, stored:true, reused?, ack:"Got it."}` |
| `thought` | `{op:"list", limit?}` | `{thoughts:[…]}`, newest first |
| `thought` | `{op:"delete", id}` | `{id, deleted}`; idempotent |
| `notebook` | `{op:"list", limit?}` | `{sessions:[{id, surface, startedAt, endedAt, seconds, legs, turnCount, actionCount, noteCount, truncated, preview}], limits}`, newest first |
| `notebook` | `{op:"get", id}` | `{session:{…, turns:[{speaker:"you"\|"bb"\|"thread", text, at, typed?, noteId?}], actions:[{…, link:"@thread:…"}], notes}}` or `{session:null}` |
| `ambient` | `{op:"start", intervalMs?, quietHours?}` / `{op:"stop"}` / `{op:"status"}` | status |
| `ambient` | `{op:"poll"}` | `{interrupt, digest, status}`: each is null or `{id, kind, title, body, count, more, threadIds, reasons}` |
| `ambient` | `{op:"flush"}` | same as `poll`, but delivers whatever is waiting now as one digest (the music was paused) |
| `ambient` | `{op:"ack", id, spoken}` | `{acknowledged}` |
| `ambient` | `{op:"deadline", id, title, dueAt}` | `{result:"queued"\|"suppressed"\|"ignored"}` |

## Sources

- A2 https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/mixwithothers
- A6 https://developer.apple.com/documentation/coreaudiotypes/avaudiosession/errorcode/cannotstartrecording
- A7 https://developer.apple.com/documentation/coreaudiotypes/avaudiosession/errorcode/cannotinterruptothers
- A10 https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetooth
- A11 https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetootha2dp
- A12 https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/bluetoothhighqualityrecording
- A13 https://developer.apple.com/documentation/avfaudio/avaudiosession/setactiveoptions/notifyothersondeactivation
- A14 https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionoptions/shouldresume
- A15 https://support.apple.com/en-us/108331
- A18 https://developer.apple.com/documentation/speech/speechanalyzer
- A19 https://developer.apple.com/documentation/speech/speechdetector
- A20 https://developer.apple.com/documentation/widgetkit/controlwidgetbutton
- A22 https://developer.apple.com/documentation/appintents/appintent/supportedmodes
- A23 https://developer.apple.com/documentation/AppIntents/AudioRecordingIntent
- A24 https://developer.apple.com/documentation/mediaplayer/handling-external-player-events-notifications
- R1 https://developer.apple.com/app-store/review/guidelines/
- W1 https://developer.apple.com/videos/play/wwdc2025/251/
- W3 https://developer.apple.com/videos/play/wwdc2022/10170/
- W4 https://developer.apple.com/videos/play/wwdc2025/253/
- N1 https://support.apple.com/en-us/102536
- N2 https://developer.apple.com/videos/play/wwdc2021/10091/
- F1 https://developer.apple.com/forums/thread/755784
- F3 https://developer.apple.com/forums/thread/741513
- F4 https://developer.apple.com/forums/thread/73082
- F5 https://developer.apple.com/forums/thread/815725
- S1 https://github.com/scosman/Biscotti/issues/88
- S2 https://www.apple.com/newsroom/2025/06/airpods-now-more-versatile-with-studio-quality-audio-recording-and-camera-remote/
- S3 https://community.spotify.com/t5/iOS-iPhone-iPad/My-music-does-not-resume-after-watching-a-short-video-on-other/td-p/5859602
- S4 https://picovoice.ai/blog/ios-speech-recognition/
