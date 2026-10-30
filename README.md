# agentbuffs

Installs the agentbuffs MCP server and the `find-agent-tools` skill for
agents on your machine: Claude Code, Codex, Cursor, VS Code, and others.
Your agent can then search [agentbuffs.com](https://agentbuffs.com) for
MCP servers and skills.

## Run it

```sh
curl -fsSL https://agentbuffs.com/install | sh
```

Or, with Node 20 or later:

```sh
npx agentbuffs
```

In a terminal, the tool runs as a full-screen wizard. Each step replaces the
screen:

1. Agents: the tool detects local agents and selects them by default.
2. Parts: the MCP server, the skill, or both.
3. Plan: one line per agent, for example:

   ```
   ◇  Plan
   │  Claude Code   MCP server + skill
   │  Cursor        MCP server + skill
   │  ChatGPT       manual steps, shown at the end
   ```

   Select Install, Show the changes first (lists every path, entry, and
   command, one page at a time), or Cancel. The tool writes nothing until you
   select Install.
4. Install: a line per agent as each one finishes.

When the run ends, the terminal restores its previous state and leaves a
short summary in the scrollback:

```
┌   agentbuffs 0.3.1
│
◇  Done
│  ✓ Claude Code          MCP server + skill
│  • Codex                already set up
│  ✗ GitHub Copilot CLI   skill (MCP: copilot not found on PATH)
│
└  Restart Claude Code, then ask your agent:
```

The summary also lists manual setup steps and backups. Pressing Ctrl+C
before the install exits the screen and prints `Cancelled. Nothing
was written.`

## Options

| Flag | What it does |
| --- | --- |
| `--client <slug,...>` | Set up these agents, for example `claude-code,cursor` |
| `--what mcp\|skill\|both` | Install only the MCP server, only the skill, or both |
| `--yes` | Install without asking: no questions at all. Without `--what` it installs both parts. Without `--client` it uses the agents it finds. |
| `--dry-run` | Show the plan and every change, and write nothing |
| `--verbose` | Show every change before asking |
| `--no-fullscreen` | Print line by line instead of one screen per step |
| `--api <url>` | Use another setup server (for development) |
| `--version` | Print the version |
| `--help` | Print the options |

In non-interactive environments like scripts or CI, pass `--client` with
`--yes`, or pass `--dry-run`. Otherwise, the tool prints the plan and exits with
code 2. Non-interactive output uses plain text without banners, color, or
spinners. `NO_COLOR` also disables color in terminals. With `--yes`,
`--no-fullscreen`, `NO_COLOR`, `TERM=dumb`, or a terminal smaller than 60 by
18, the tool prints line by line instead of the full-screen wizard.

Exit codes: 0 done, 1 a step failed, 2 a usage problem, 130 cancelled.

## What it changes

The tool fetches agent setup definitions from
`https://agentbuffs.com/api/discover/v1/setup` at runtime. For each agent,
it performs one of these actions:

- Runs the agent CLI, for example
  `claude mcp add --scope user --transport http agentbuffs https://agentbuffs.com/api/mcp`.
  It only calls allowlisted binaries (`claude`, `codex`, `gemini`,
  `code`, `copilot`, `pi`, `grok`, `goose`) directly, bypassing the shell.
- Adds an `agentbuffs` entry to a JSON or TOML config file, such as
  `~/.cursor/mcp.json` or `~/.codex/config.toml`. It preserves existing
  content.
- Verifies the SHA-256 hash against the setup payload and writes the skill file,
  for example `~/.claude/skills/find-agent-tools/SKILL.md`.
- Prints instructions for applications that require manual setup.

Before modifying a file, the tool creates a `<file>.bak` copy and prints the
path at the end. It writes updates to a temporary file before replacing the
target. It skips unparseable files and files that already contain the target
entry. If a conflicting `agentbuffs` entry exists, it prompts for
confirmation (`--yes` replaces it without asking). It writes files only within your home directory and the current
directory.

An agent that follows `XDG_CONFIG_HOME` (OpenCode) gets its config there when
the variable is set to an absolute path, and in `~/.config` otherwise. If
`XDG_CONFIG_HOME` points outside your home directory, the tool does not write
there. It tells you so and leaves that agent for you to set up by hand.

## Privacy

The tool sends no telemetry. It makes two network requests: one for the setup
manifest and one for the skill file. Read the
[privacy policy](https://agentbuffs.com/privacy).

## Development

```sh
pnpm install
pnpm check   # typecheck, build dist/cli.mjs, run the tests
```

The build compiles the project into `dist/cli.mjs`. The published package
has no runtime dependencies.

## License

MIT
