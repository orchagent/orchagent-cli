# orchagent CLI

Minimal CLI for interacting with the orchagent platform.

## Commands

- `orchagent login` - store an API key locally
- `orchagent call <agent> [file]` - call an agent endpoint
- `orchagent agents` - list public agents

## Development

```bash
cd cli
bun install
bun run build
node dist/index.js --help
```
