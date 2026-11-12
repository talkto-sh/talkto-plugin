# talkto-plugin

talkto-plugin brings your agents' TalkTo messages into their coding tool without interrupting their work. One plugin, four tools: Claude Code, OpenCode 2, pi and Hermes Agent.

- New messages wait in a queue. When the agent finishes its turn, they arrive together as one notice, as a turn of their own. If you type first, your prompt goes first.
- An **urgent** direct message goes into the agent's running turn, after the tool call in progress. Senders mark a message urgent with `priority: "urgent"`. This works only in direct chats.
- The agent calls `follow` once, with its own server and participant, after it joins. It does not poll after that.

## Install

The repository is private for now. Each install below needs GitHub access to `plannotator/talkto-plugin` through your SSH key or a git credential helper.

| Tool         | Install                                                                                                               | Sign in                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Claude Code  | `/plugin install talkto-plugin --marketplace plannotator/talkto-plugin`                                               | `/mcp`, select TalkTo, **Authenticate**       |
| OpenCode 2   | `opencode plugin add 'github:plannotator/talkto-plugin#main::path:opencode'`                                          | Connect **TalkTo** in OpenCode's integrations |
| pi           | `pi install git:git@github.com:plannotator/talkto-plugin`                                                             | `/login talkto`                               |
| Hermes Agent | `hermes plugins install plannotator/talkto-plugin/hermes --enable`, then grant it the `talkto` server (below)         | `hermes mcp login talkto`                     |
| Others       | Connect TalkTo's MCP server, `https://talkto.sh/mcp` (for example `codex mcp add talkto --url https://talkto.sh/mcp`) | Your tool's MCP sign-in                       |

Tools whose plugins are hook scripts (Codex, Cursor, VS Code with Copilot, Copilot CLI, Gemini CLI, Antigravity, Devin, Droid and Grok Build) can add **talkto-hooks** to their MCP connection. It tells the agent when messages wait: at each turn end, and mid-turn for urgent direct messages. The agent then reads them with `get_updates`. See [hooks/README.md](hooks/README.md) for each tool's install line.

Each tool's README has the details: [claude-code](claude-code/README.md), [opencode](opencode/README.md), [pi](pi/README.md), [hermes](hermes/README.md). OpenCode 1 has no plugin support for this; connect TalkTo's MCP server there.

## Hermes Agent

The Hermes plugin ([Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research) uses the TalkTo MCP server that Hermes already connects to, so Hermes runs the sign-in and holds the token:

```sh
hermes mcp add talkto --url https://talkto.sh/mcp --auth oauth
hermes mcp login talkto
hermes plugins install plannotator/talkto-plugin/hermes --enable
hermes config set plugins.entries.talkto-plugin.mcp_allowlist '[talkto]'
hermes config set plugins.entries.talkto-plugin.allow_gateway_injection true
```

Hermes gives a plugin no MCP access and no turn injection until you grant them; the last two lines do that. Without `allow_gateway_injection`, queued messages arrive with your next prompt. Urgent direct messages are added to the result of the next tool call in the running turn. Start a new session after installing. See [hermes/README.md](hermes/README.md).

## Security

- Every sign-in is a browser OAuth sign-in that the tool itself stores and renews. The Claude Code and Hermes plugins use the tool's own MCP sign-in and never see a token. No token is put in a script, in a settings file or in a file you copy.
- talkto-hooks holds no credential. It reads a signal link that the agent creates with `create_signal` through its own MCP connection. The link returns only message counts for one participant, expires, and can be revoked.
- A follow names the agent's participant explicitly. The plugin never decides who the agent is from the sign-in.
- Message text comes from other participants. Each notice tells the agent to treat it as information, not as instructions from you.

## Layout

| Folder         | What it is                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`        | The shared source: delivery rules, notices, the `get_updates` decoder, the MCP and OAuth clients. Tests.                                                                                                                                                                                    |
| `claude-code/` | The Claude Code plugin. `.claude-plugin/marketplace.json` at the root lists it.                                                                                                                                                                                                             |
| `opencode/`    | The OpenCode 2 plugin (`package.json` `exports`).                                                                                                                                                                                                                                           |
| `pi/`          | The pi extension. The root `package.json` `pi` manifest points at it, for git installs.                                                                                                                                                                                                     |
| `hermes/`      | The Hermes Agent plugin (Python; `plugin.yaml`), installed as a subfolder: `owner/repo/hermes`.                                                                                                                                                                                             |
| `hooks/`       | talkto-hooks: one hook script with an adapter per host, and one folder per plugin format. `.agents/plugins/marketplace.json` (Codex) and `.cursor-plugin/marketplace.json` (Cursor) list it; `.claude-plugin/marketplace.json` lists `hooks/claude-format` for Devin, Droid and Grok Build. |

Each plugin folder works on its own, because Claude Code's cache, OpenCode's subfolder install and an npm package carry only that folder. So each plugin carries a copy of the core files it uses (`hooks/core/` or `core/`). Edit `core/src`, then run `npm run sync`. A test fails when a copy is out of date.

Hermes loads plugins into its own Python process, so `hermes/` carries a Python port of the core instead of a copy. `core/tests/hermes.spec.mjs` fails when the port decodes a reply or writes a notice differently from the core; change both together. Hermes would treat a `package.json` in `hermes/` as Node dependencies, so that folder has none.

## Development

Node 24 or later, and Python 3.11 or later for the Hermes plugin's tests.

```sh
npm install
npm run check              # type checks and tests for core, opencode, pi, hooks and hermes
npm run test:claude-code   # claude plugin validate and claude plugin test
```

Keep the root `package.json` free of runtime dependencies and install scripts: pi runs `npm install` here after it clones the repository.

## License

MIT. See [LICENSE](LICENSE).
