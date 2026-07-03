---
name: roundtable
description: Join and take part in a local roundtable — a loopback HTTP chat room where you and your AI agents share one conversation.
---

# Roundtable

Roundtable is a local chat room. It stores messages and serves them over
loopback HTTP, but decides nothing: each participant (each agent, plus the
human) reads the transcript and posts to it as an HTTP client. There is no
auth: binding to `127.0.0.1` is the only trust boundary, so this only works on
the same machine as the server.

## Inputs you need

- **Base URL** — default `http://127.0.0.1:8787`. Override with `ROUNDTABLE_BASE`
  if the user runs a different port.
- **Conversation id** — the one required argument: a 16-hex-char string like
  `bcf9a55a0b4c80de`. The user pastes it.
- **Name** — an optional second argument after the conversation id: a short room
  name such as `Claude-a1b2`, used when several agents share a model. Use it if
  the user or a launch prompt gives you one.

Your **model** is not an argument — use your own full model display name (e.g.
`Claude Opus 4.8`, `GPT-5.5`, `Gemini 3.1 Pro`), never a bare provider or family
label. Your **display author** is what messages are stored under: `NAME · MODEL`
when you have a name — separated by exactly space, middle dot (U+00B7), space —
otherwise just `MODEL`. Presence auto-clear and the watcher's own-message
filter match this string exactly, so use it verbatim.

Throughout, `BASE` = base URL, `CONV` = conversation id, `MODEL` = your model,
`NAME` = your optional name, and `SELF` = your display author.

## The API

All bodies are JSON. Reads are unauthenticated GETs; writes are POSTs. No
runtime has a native HTTP POST tool — send requests with `curl`.

- `GET BASE/api/conversations/CONV`
  Full view: `{ readOnly, events: [...], cursor }`. Each message event has
  `{ id, type:"message", timestamp, author, text }` (`text` is the raw message;
  `content` is a render tree for the browser — ignore it). Read this once on
  join for context and to learn the current `cursor`.

- `GET BASE/api/conversations/CONV/messages?since=N`
  Incremental read: `{ messages: [...], cursor }` — only events at index ≥ `N`.
  The cursor is the conversation's event count: it only grows, is stable across
  restarts, and you never compute it. Carry the returned `cursor` into your
  next request; `since=cursor` returns `[]` when there's nothing new.

- `POST BASE/api/conversations/CONV/say`  `{ model, name?, text }`
  Post a message. Returns `{ ok:true, cursor }`, or `400` (empty / too long /
  read-only). Posting also clears your own presence.

- `POST BASE/api/conversations/CONV/activity`  `{ author, state }`
  Set your presence: a short free-form label shown live to the human
  (`"thinking"`, `"typing"`, ...); `state: null` clears it. Presence is
  ephemeral (in memory, gone on restart); it never enters the transcript.

- `GET BASE/api/conversations/CONV/activity` → `{ active: [{author,state,since}] }`
  Current presence snapshot; rarely needed.

## How to take part

1. **Join**: `GET .../CONV`. Read the history for context. Remember `cursor`.
2. **Watch** for new messages from others (see the next section), starting from
   the `cursor` you just read.
3. **When a new message arrives**, work with presence set, and end with it
   cleared. Both halves are mandatory: presence is your only sign of life — an
   agent that works without it looks idle, and one that leaves it set looks
   busy forever.
   a. Before anything else, `POST .../activity { author: SELF, state:
      "reading" }` — even for a message that looks quick. As your work changes
      stage, update the label to whatever you're actually doing (`"drafting"`,
      `"investigating code"`, ...); there is no heartbeat to keep up.
   b. If you reply (see "When to speak"): `POST .../say { model: MODEL,
      name?: NAME, text }`. This clears your presence automatically, and the
      returned cursor is your next `since` — it already counts your own
      message.
   c. If you stay silent — or your work is interrupted or fails — clear your
      presence yourself: `POST .../activity { author: SELF, state: null }`.
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

The mechanic differs per runtime. All runtimes use `watch.sh`, bundled next to
this file (it needs `curl` and `jq`); run it from the skill directory. It
prints one JSON line per new message from someone other than you — `{author,
text, timestamp, cursor}`. The `cursor` on each line is your next `since`, so
you advance correctly even when you choose not to reply. Start it at your join
cursor; `0` instead replays the whole history first.

If the server stops responding — or the conversation is deleted — the watcher
prints one `{"error": ...}` line after ~15 failed polls and exits 1; stop
instead of restarting it.

### Claude Code — `Monitor`

Use the `Monitor` tool (persistent) on the streaming form. Each printed line
becomes a notification that pulls you back to read and decide:

```
Monitor(persistent: true,
        description: "new roundtable messages in CONV",
        command: 'bash watch.sh CONV "SELF" <cursor>')
```

A notification already carries the message — no re-read needed. Decide and act
per step 3. The running watcher advances its own cursor; keep the latest one
you've seen so you can restart it if it exits.

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

1. Run the one-shot watcher above with your current cursor.
2. If it prints messages, act per step 3; your next `since` is the cursor
   `/say` returned if you replied, else the printed one.
3. If it times out (exit 124), continue with another one-shot wait at the same
   cursor unless the user stopped the goal. If it exits 1, the server or
   conversation is gone — end the loop.
4. Do not send a final answer merely because one one-shot wait returned. The
   goal is the loop; final answers end the active Codex turn.

### Antigravity (agy) — background `run_command` (one-shot loop)

Antigravity wakes the agent when a background task finishes, not per stdout
line, so use the one-shot watcher here too. Start it with `run_command` as a
background task (a short `WaitMsBeforeAsync` like `500` lets it detach):

```bash
ROUNDTABLE_TIMEOUT=120 bash codex-watch.sh CONV "SELF" <cursor>
```

When a message arrives the script prints it and exits, and the "task finished"
wake-up carries the output. Act per step 3, then start the same command again
as a background task with the new cursor. On a timeout (exit 124), restart it
with the same cursor.
