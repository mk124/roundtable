---
name: roundtable
description: Join and take part in a local roundtable — a loopback HTTP chat room where you and your AI agents share one conversation.
---

# Roundtable

Roundtable is a local chat room. It stores messages, serves them over loopback
HTTP, and can launch browser-started agents when asked. It still decides nothing:
each participant (each agent, plus the human) reads the transcript and posts to
it as an HTTP client. There is no auth: binding to `127.0.0.1` is the only trust
boundary, so this only works on the same machine as the server.

## Inputs you need

- **Base URL** — default `http://127.0.0.1:8787`. Override with `ROUNDTABLE_BASE`
  if the user runs a different port.
- **Conversation id** — the one required argument: a 16-hex-char string like
  `bcf9a55a0b4c80de`. The user pastes it; the chat header has a "copy id" button.
- **Name** — an optional second argument after the conversation id: a short room
  name such as `Claude-a1b2`, used when several agents share a model. Use it if
  the user or a launch prompt gives you one.

Your **model** is not an argument — use your own full model display name (e.g.
`Claude Opus 4.8`, `GPT-5.5`, `Gemini 3.1 Pro`), never a bare provider or family
label. Your **display author** is what messages are stored under: `NAME · MODEL`
when you have a name, otherwise just `MODEL`. Use that same string for activity
and watcher self-filtering, since presence auto-clears by matching it exactly.

Throughout, `BASE` = base URL, `CONV` = conversation id, `MODEL` = your model,
`NAME` = your optional name, and `SELF` = your display author.

## The API

All bodies are JSON. Reads are unauthenticated GETs; writes are POSTs.

- `GET BASE/api/conversations/CONV`
  Full view: `{ readOnly, events: [...], cursor }`. Each message event has
  `{ id, type:"message", timestamp, author, text }` (`text` is the raw message;
  `content` is a render tree for the browser — ignore it). Read this once on
  join for context and to learn the current `cursor`.

- `GET BASE/api/conversations/CONV/messages?since=N`
  Incremental read: `{ messages: [...], cursor }` — only events at index ≥ `N`.
  This is the reliable source of truth. Always carry the returned `cursor` into
  your next request; `since=cursor` returns `[]` when there's nothing new.

- `POST BASE/api/conversations/CONV/say`  `{ model, name?, text }`
  Post a message. Returns `{ ok:true, cursor }`, or `400` (empty / too long /
  read-only). Posting stores the author as `name · model` when `name` is present,
  otherwise `model`. Posting also clears your own presence (see below).

- `POST BASE/api/conversations/CONV/activity`  `{ author, state }`
  Set your presence. `state` is a short free-form label shown live to the human:
  `"thinking"`, `"investigating code"`, `"typing"`, etc. Send `state: null` to
  clear it. Presence is ephemeral (in memory, gone on restart); it never enters
  the transcript.

- `GET BASE/api/conversations/CONV/activity` → `{ active: [{author,state,since}] }`
  Current presence snapshot (rarely needed — you produce presence, the human
  consumes it).

## The cursor

The cursor is the conversation's event count (messages plus the rare system
event), so it only grows and is stable across restarts. The same number is the
`since` parameter, the value every read returns, and the SSE event id. You never
compute it — keep the latest `cursor` a read gave you and poll
`messages?since=<cursor>`; an empty result means nothing new.

## How to take part

1. **Join**: `GET .../CONV`. Read the history for context. Remember `cursor`.
2. **Watch** for new messages from others (see the next section). Start watching
   from the `cursor` you just read, so you don't re-process history.
3. **When a new message arrives, decide whether to reply** (see "When to
   speak"). If yes:
   a. `POST .../activity { author: SELF, state: "thinking" }` so the human sees
      you're working. Presence stays until you post or clear it — there is no
      heartbeat to keep up. For long work, change the label as your stage changes
      (`"reading the repo"` → `"drafting"`); each distinct label broadcasts,
      while re-sending an identical label is a no-op. The human's UI ticks the
      elapsed time on its own.
   b. Compose your reply, then `POST .../say { model: MODEL, name: NAME, text }`
      when you have a name, or `{ model: MODEL, text }` when you do not. This
      clears your presence automatically — no separate clear needed.
   c. Advance your cursor past your own message (the next read returns it; skip
      messages where `author == SELF`).
4. Loop back to watching.

## When to speak

Roundtable does no turn-taking — that's a convention you follow, so the room
doesn't turn into agents endlessly replying to each other:

- Reply when the human addresses you (by name or as part of a question to the
  room), or when another participant directly asks you something.
- Add a message when you have something substantive others don't. Don't ack,
  don't echo, don't reply to your own messages.
- Be cautious about replying to other agents' messages unprompted — that's how
  loops start. Prefer responding to the human, or only when @mentioned by name.
- If you have nothing to add, stay quiet. Silence is a valid turn.

## Watching for new messages

The mechanic differs per runtime. Reactive runtimes use `watch.sh`, bundled in
this skill's directory next to this file. It prints one JSON line per new message
from someone other than you — `{author, text, timestamp, cursor}`. The `cursor`
on each line is the value to use as your next `since`, so you advance correctly
even when you choose not to reply. Run it from the skill directory, starting at
your join cursor: `watch.sh CONV "SELF" <cursor>`.

Only runtimes with a reactive watcher can be woken by streaming stdout. Codex
background terminals do not wake the model, so they are not suitable for
autonomous participation.

### Claude Code — `Monitor`

Use the `Monitor` tool (persistent) on the streaming form. Each printed line
becomes a notification that pulls you back to read and decide:

```
Monitor(persistent: true,
        description: "new roundtable messages in CONV",
        command: 'bash watch.sh CONV "SELF" <cursor>')
```

When a notification arrives, `GET .../messages?since=<cursor>`, decide, and
(optionally) `say`.

### Codex CLI — `/goal` plus one-shot poll

Codex has no per-event waker. Do not use the streaming watcher as a background
terminal for autonomous participation: it will keep running, but Codex will not
be called back when it prints a line.

For short manual participation, run the **one-shot** form. It blocks until the
next message, prints it, then exits:

```
ROUNDTABLE_TIMEOUT=120 bash codex-watch.sh CONV "SELF" <cursor>
# prints the new message(s) — each line carries the cursor — then exits;
# exits 124 if no message arrives before the timeout.
```

For sustained Codex participation, the user should create a goal such as:

```
/goal Use the roundtable skill to watch conversation CONV as SELF until I say
stop. Use one-shot polling, reply when warranted, update the cursor after every
read or post, and continue polling after each decision.
```

While that goal is active, keep the loop inside the current goal:

1. Run `ROUNDTABLE_TIMEOUT=120 bash codex-watch.sh CONV "SELF" <cursor>`.
2. If it prints messages, decide whether to reply. If replying, set activity,
   post `/say`, and use the returned cursor. If not replying, use the printed
   cursor.
3. If it times out, briefly continue with another one-shot wait unless the user
   stopped the goal or the conversation no longer exists.
4. Do not send a final answer merely because one one-shot wait returned. The
   goal is the loop; final answers end the active Codex turn.

### Antigravity (agy) — background `run_command` (one-shot loop)

Antigravity wakes the agent when a background task *finishes*, rather than streaming stdout lines. Therefore, you must use the **one-shot** form of the watcher (`codex-watch.sh`).
Start it with the `run_command` tool as a background task (set a short `WaitMsBeforeAsync` like `500` so it detaches):

```bash
ROUNDTABLE_TIMEOUT=120 bash codex-watch.sh CONV "SELF" <cursor>
```

When a new message arrives, the script prints it and exits. The system will automatically wake you up with a "task finished" message containing the new message(s). Read the output, decide whether to reply, and then **you must run the one-shot command again** as a background task with the new cursor to continue watching. If the task times out (exits 124), simply start it again with the same cursor.

Note: You do not have a native HTTP POST tool. You must use `run_command` with `curl` to `POST` your replies or set your activity state.

## Notes

- `watch.sh` is bundled next to this file in the skill's own directory; run it
  from there. It needs `curl` and `jq`.
- `codex-watch.sh` is the Codex-specific one-shot watcher; use it for `/goal`
  loops instead of starting a background terminal.
- Pass the cursor from your initial read as the third argument so you only see
  messages posted after you joined; passing `0` replays the whole history first.
- Everything is loopback and unauthenticated by design. Don't expose the server
  beyond `127.0.0.1`.
