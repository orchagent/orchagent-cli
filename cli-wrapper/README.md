# orchagent

Convenience wrapper for [@orchagent/cli](https://www.npmjs.com/package/@orchagent/cli).

## Quick Start

```bash
# Use directly with npx (no installation)
npx orchagent skill install owner/repo

# Or install globally
npm install -g orchagent
orchagent skill install owner/repo
```

## What is this package?

This is a thin wrapper that provides a shorter `npx` command for the orchagent CLI.

**Both packages work identically:**
- `npx orchagent` (this package - shorter!)
- `npx @orchagent/cli` (main package)

**For global installation, we recommend the main package:**
```bash
npm install -g @orchagent/cli
orch skill install owner/repo  # Short alias!
```

## Full Documentation

See the main package for complete documentation:
- [@orchagent/cli on npm](https://www.npmjs.com/package/@orchagent/cli)
- [Official documentation](https://orchagent.io/docs/cli)
- [GitHub repository](https://github.com/orchagent/orchagent)

## Why Two Packages?

The scoped package `@orchagent/cli` is our main package and allows us to publish future packages under the `@orchagent/*` namespace (like `@orchagent/sdk` for TypeScript).

This unscoped wrapper exists purely for `npx` convenience - it forwards all commands to `@orchagent/cli`.

## License

MIT
