# agentbuffs

Adds the agentbuffs MCP server and the `find-agent-tools` skill to the agent
harnesses on your machine: Claude Code, Codex, Cursor, VS Code and others.
After that, your agent can search [agentbuffs.com](https://agentbuffs.com) for
MCP servers and skills.

## Run it

```sh
curl -fsSL https://agentbuffs.com/install | sh
```

or, with Node 20 or later:

```sh
npx agentbuffs
```

It finds the harnesses you have installed and asks which ones to set up and
what to install (the MCP server, the skill, or both). Then it shows every
change it will make and asks you to confirm. Nothing changes until you say yes.

## Options

| Flag | What it does |
| --- | --- |
| `--client <slug,...>` | Set up these harnesses, for example `claude-code,cursor` |
| `--what mcp\|skill\|both` | Install only the MCP server, only the skill, or both |
| `--yes` | Apply the plan without asking |
| `--dry-run` | Show the plan and write nothing |
| `--api <url>` | Use another setup server (for development) |
| `--version` | Print the version |
| `--help` | Print the options |

Without a terminal (in a script or CI), pass `--client` and `--yes`, or
`--dry-run`. Otherwise it prints the plan and exits with code 2.

Exit codes: 0 done, 1 a step failed, 2 a usage problem, 130 cancelled.

## What it changes

The list of harnesses and what to do for each comes from
`https://agentbuffs.com/api/discover/v1/setup` when you run it. For each
harness it does one of these:

- Runs the harness's own command, for example
  `claude mcp add --scope user --transport http agentbuffs https://agentbuffs.com/api/mcp`.
  It runs only a fixed list of harness commands (`claude`, `codex`, `gemini`,
  `code`, `copilot`, `pi`, `grok`, `goose`), never through a shell.
- Adds one `agentbuffs` entry to a JSON or TOML config file, such as
  `~/.cursor/mcp.json` or `~/.codex/config.toml`. The rest of the file stays
  as it was.
- Writes the skill file, for example
  `~/.claude/skills/find-agent-tools/SKILL.md`, after it checks the file's
  SHA-256 against the setup list.
- Prints steps for apps that you set up in their own settings.

Before it changes a file, it copies the file to `<file>.bak`. It writes the
new file to a temporary file first and then moves it into place. It does not
touch a file it cannot parse. If the same entry is already there, it leaves
the file alone. If a different `agentbuffs` entry is there, it asks first.
It writes only inside your home folder and the current folder.

## Privacy

It sends no telemetry. It makes two requests: one for the setup list, and one
for the skill file. See the [privacy policy](https://agentbuffs.com/privacy).

## Development

```sh
pnpm install
pnpm check   # typecheck, build dist/cli.mjs, run the tests
```

The build bundles everything into one file, `dist/cli.mjs`, so the published
package has no runtime dependencies.

## License

MIT
