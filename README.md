# agentbuffs

Installs the agentbuffs MCP server and the `find-agent-tools` skill for
agents on your machine: Claude Code, Codex, Cursor, VS Code and others.
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

The tool detects local agents and selects them by default. Choose which
agents to configure and what to install: the MCP server, the skill, or both.
The tool then displays a plan:

```
Claude Code   MCP server + skill
Cursor        MCP server + skill
ChatGPT       manual steps, shown at the end
```

Select Install, Show the changes first (lists every path, entry and command),
or Cancel. The tool writes nothing until you select Install. After installation,
it reports status per agent:

```
✓ Claude Code          MCP server + skill
• Codex                already set up
✗ GitHub Copilot CLI   skill (MCP: copilot not found on PATH)
```

Manual setup instructions follow, then a list of created backups.

## Options

| Flag | What it does |
| --- | --- |
| `--client <slug,...>` | Set up these agents, for example `claude-code,cursor` |
| `--what mcp\|skill\|both` | Install only the MCP server, only the skill, or both |
| `--yes` | Install without asking |
| `--dry-run` | Show the plan and every change, and write nothing |
| `--verbose` | Show every change before asking |
| `--api <url>` | Use another setup server (for development) |
| `--version` | Print the version |
| `--help` | Print the options |

In non-interactive environments like scripts or CI, pass `--client` with
`--yes`, or pass `--dry-run`. Otherwise the tool prints the plan and exits with
code 2. Non-interactive output uses plain text without banners, colour, or
spinners. `NO_COLOR` disables colour in terminals as well.

Exit codes: 0 done, 1 a step failed, 2 a usage problem, 130 cancelled.

## What it changes

The tool fetches agent setup definitions from
`https://agentbuffs.com/api/discover/v1/setup` at runtime. For each agent,
it performs one of these actions:

- Runs the agent's CLI, for example
  `claude mcp add --scope user --transport http agentbuffs https://agentbuffs.com/api/mcp`.
  It only calls allowlisted binaries (`claude`, `codex`, `gemini`,
  `code`, `copilot`, `pi`, `grok`, `goose`) directly, bypassing the shell.
- Adds an `agentbuffs` entry to a JSON or TOML config file, such as
  `~/.cursor/mcp.json` or `~/.codex/config.toml`. It preserves existing
  content.
- Verifies the SHA-256 hash against the setup payload and writes the skill file,
  for example `~/.claude/skills/find-agent-tools/SKILL.md`.
- Prints instructions for applications that require manual configuration.

Before modifying a file, the tool creates a `<file>.bak` copy and prints the
path at the end. It writes updates to a temporary file before replacing the
target. It skips unparseable files. It skips files that already contain the
target entry. If a conflicting `agentbuffs` entry exists, it prompts for
confirmation. It only writes files within your home directory and the current
directory.

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
carries no runtime dependencies.

## License

MIT
