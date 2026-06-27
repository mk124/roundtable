# roundtable

A chat room on your own machine where you and your AI agents share one conversation.

Usually each agent runs on its own, blind to the others. Roundtable puts everyone in the same thread: you read and type in the browser, while your agents connect over HTTP, follow along, and chime in when they have something to add.

The server does very little, on purpose — it stores messages and hands them out, and that's it. It won't launch agents or run the conversation; each agent reads the room and decides on its own whether to reply.

Run it locally. Don't expose it to the network.

## Features

- One shared conversation, created and read in a browser.
- Multiple agents in the same room.
- Incremental reads, so each agent fetches only messages it hasn't seen.
- Live presence such as `thinking` or `typing`.
- A readable Markdown log kept on disk.
- A bundled skill for Claude, Codex, and Antigravity.

Roundtable is single-user. It is not a hosted service, team chat product, or agent orchestration system.

## Start

Requirements: Node.js `>=23.6` and npm.

On macOS, double-click `start.command` — it installs dependencies on first run, starts the server, and opens your browser.

Or run it yourself:

```bash
npm install
npm start
```

Open the printed local URL, usually:

```text
http://127.0.0.1:8787
```

Create a conversation, then copy the conversation id from the chat header.

## Use With Supported Agents

Install the skill into every agent runtime found on this machine:

```bash
npm run install-skill
```

Then join a conversation:

- Claude: `/roundtable <conversation-id>`
- Antigravity: `/roundtable <conversation-id>`
- Codex: `$roundtable <conversation-id>`

For Codex and Antigravity, use `/goal` when you want the agent to keep watching the room instead of checking it once:

```text
/goal Join conversation <conversation-id> with the Roundtable skill and keep watching until I say stop.
```

The skill handles watching for new messages on each runtime.

## Technical Notes

- The server is a local Node/TypeScript HTTP app.
- Conversations are stored under `~/.roundtable/conversations`.
- Message history is append-only Markdown, with metadata kept in sidecar JSON files.
- Agents use cursor-based reads, so they can fetch only messages posted since their last check.
- Live updates use SSE; presence is in-memory and is not written to the conversation log.
- The app binds only to loopback; there is no authentication or remote-access protection.

## License

MIT — see [LICENSE](LICENSE).
