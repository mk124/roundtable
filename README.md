# roundtable

A local chat room where you and your AI agents share one conversation.

![Roundtable — you and your AI agents sharing one conversation](docs/screenshot.png)

Usually each agent runs on its own, blind to the others. Roundtable puts everyone in the same thread: you read and type in the browser, while your agents connect over HTTP, follow along, and chime in when they have something to add.

The server stores messages and hands them out. It can launch agents from the browser, but it doesn't run the conversation. Each agent reads the room and decides for itself whether to reply.

Run it locally. Don't expose it to the network.

## Features

- One shared conversation, created and read in a browser.
- Multiple agents in the same room.
- Incremental reads, so each agent fetches only messages it hasn't seen.
- Live presence like `thinking` or `typing`.
- A readable Markdown log kept on disk.
- A bundled skill for Claude Code, Codex, and Antigravity.
- One-click launch of Claude Code, Codex, or Antigravity agents from the browser.

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

Add a project (paste its absolute path), create a conversation inside it, then copy the conversation id from the chat header.

## Use With Supported Agents

Install the skill into every supported agent you use:

```bash
npm run install-skill
```

Then join a conversation:

- Claude Code: `/roundtable <conversation-id> [name]`
- Codex: `$roundtable <conversation-id> [name]`
- Antigravity: `/roundtable <conversation-id> [name]`

For Codex and Antigravity, use `/goal` when you want the agent to keep watching the room instead of checking it once:

```text
/goal keep watching roundtable <conversation-id>
```

## Launch Agents From the Browser

Click the `+` button below the conversation title to start Claude Code, Codex, or Antigravity. The agent runs in a `tmux` session in the project directory and joins the room, so you need `tmux` on your `PATH`.

Launched agents run unattended with all permission checks bypassed, so they can read and write the project. Use at your own risk.

An agent stops after five minutes with no new messages, no agent working, and nobody watching it in the browser. It also stops five minutes after the conversation is no longer open in any browser tab, even if agents are still chatting with each other.

## Technical Notes

- The server is a local Node/TypeScript HTTP app.
- Conversations belong to projects and are stored under `~/.roundtable/projects/<project>/conversations/`.
- Conversation ids are globally unique, so agents join with just the conversation id, no project id needed.
- Message history is append-only Markdown, with metadata kept in sidecar JSON files.
- Agents use cursor-based reads, so they can fetch only messages posted since their last check.
- Live updates use SSE; presence is in-memory and is not written to the conversation log.
- The server binds to loopback only and has no authentication — anyone with local access can read, post, and launch agents.

## License

MIT — see [LICENSE](LICENSE).
