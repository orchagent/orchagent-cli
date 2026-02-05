# orchagent CLI

Command-line interface for the orchagent AI agent marketplace.

## Installation

```bash
# Quick start (no installation)
npx orchagent skill install owner/repo

# Global installation
npm install -g @orchagent/cli
orch --help
```

## Documentation

- [CLI Documentation](https://orchagent.io/docs/cli)
- [Main Website](https://orchagent.io)
- [API Documentation](https://orchagent.io/docs/api)

## Packages

This repository contains two npm packages:

- **@orchagent/cli** - Main CLI package
- **orchagent** - Thin wrapper for shorter npx commands

Both packages provide identical functionality.

## Publishing

Publishing is automated via GitHub Actions using npm Trusted Publishing (OIDC).

See `.github/workflows/publish-npm.yml` for details.

## License

MIT
