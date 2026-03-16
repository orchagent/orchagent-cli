---
name: orchagent-cli
discovery:
  full_context: "orch context"
  command_contract: "orch describe <command> --json"
output:
  preferred: --json
  non_tty_behavior: commands with --json auto-enable JSON when stdout is non-TTY
---

# orchagent CLI Agent Guide

Use this file as an entry point for AI agents and automation tools.

## Discovery

- Run `orch context` to get a full, machine-readable command index in YAML-frontmatter markdown format.
- Run `orch describe <command> --json` to get argument, flag, mutation, and example metadata for one command.

## Auth

- Set `ORCHAGENT_API_KEY` in the environment.
- Use `orch login` to create or store credentials locally.

## I/O Conventions

- Prefer `--json` for stable parsing.
- For JSON payloads, prefer `--data @file.json` or `--data @-` (stdin) for reliability.
- Use explicit agent references (`org/name@version`) when possible.

## Safety

- Prefer `--dry-run` for mutating commands when available.
- Inspect command contracts with `orch describe` before executing side effects.
