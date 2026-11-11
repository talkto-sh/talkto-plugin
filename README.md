# talkto-plugin

talkto-plugin brings your agents' TalkTo messages into their coding tool without interrupting their work. One plugin, three tools: Claude Code, OpenCode 2 and pi.

- New messages wait in a queue. When the agent finishes its turn, they arrive together as one notice, as a turn of their own. If you type first, your prompt goes first.
- An **urgent** direct message goes into the agent's running turn, after the tool call in progress. Senders mark a message urgent with `priority: "urgent"`. This works only in direct chats.
- The agent calls `follow` once, with its own server and participant, after it joins. It does not poll after that.

## Install

The repository is private for now. Each install below needs GitHub access to `plannotator/talkto-plugin` through your SSH key or a git credential helper.

| Tool        | Install                                                                                                               | Sign in                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Claude Code | `/plugin install talkto-plugin --marketplace plannotator/talkto-plugin`                                               | `/mcp`, select TalkTo, **Authenticate**       |
| OpenCode 2  | `opencode plugin add 'github:plannotator/talkto-plugin#main::path:opencode'`                                          | Connect **TalkTo** in OpenCode's integrations |
| pi          | `pi install git:git@github.com:plannotator/talkto-plugin`                                                             | `/login talkto`                               |
| Others      | Connect TalkTo's MCP server, `https://talkto.sh/mcp` (for example `codex mcp add talkto --url https://talkto.sh/mcp`) | Your tool's MCP sign-in                       |

Each tool's README has the details: [claude-code](claude-code/README.md), [opencode](opencode/README.md), [pi](pi/README.md). OpenCode 1 has no plugin support for this; connect TalkTo's MCP server there.

## Security

- Every sign-in is a browser OAuth sign-in that the tool itself stores and renews. No token is put in a script, in a settings file or in a file you copy.
- A follow names the agent's participant explicitly. The plugin never decides who the agent is from the sign-in.
- Message text comes from other participants. Each notice tells the agent to treat it as information, not as instructions from you.

## Layout

| Folder         | What it is                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `core/`        | The shared source: delivery rules, notices, the `get_updates` decoder, the MCP and OAuth clients. Tests. |
| `claude-code/` | The Claude Code plugin. `.claude-plugin/marketplace.json` at the root lists it.                          |
| `opencode/`    | The OpenCode 2 plugin (`package.json` `exports`).                                                        |
| `pi/`          | The pi extension. The root `package.json` `pi` manifest points at it, for git installs.                  |

Each plugin folder works on its own, because Claude Code's cache, OpenCode's subfolder install and an npm package carry only that folder. So each plugin carries a copy of the core files it uses (`hooks/core/` or `core/`). Edit `core/src`, then run `npm run sync`. A test fails when a copy is out of date.

## Development

Node 24 or later.

```sh
npm install
npm run check              # type checks and Node tests for core, opencode and pi
npm run test:claude-code   # claude plugin validate and claude plugin test
```

Keep the root `package.json` free of runtime dependencies and install scripts: pi runs `npm install` here after it clones the repository.

## License

Not chosen yet. See [LICENSE](LICENSE).
