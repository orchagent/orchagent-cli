# Publishing Guide: CLI Wrapper

This document explains the `orchagent` wrapper package and how to publish it alongside `@orchagent/cli`.

## What is this package?

`orchagent` is a thin wrapper for `@orchagent/cli` that provides a shorter `npx` command:

```bash
npx orchagent skill install owner/repo      # Shorter (via wrapper)
npx @orchagent/cli skill install owner/repo # Main package
```

Both commands work identically. The wrapper simply forwards all calls to `@orchagent/cli`.

## Why Two Packages?

**Strategy: Best of both worlds**

1. **Scoped package (`@orchagent/cli`):** Main package that allows future npm packages under `@orchagent/*` namespace:
   - `@orchagent/cli` (current)
   - `@orchagent/sdk` (TypeScript SDK - planned in roadmap)
   - `@orchagent/go` (Go SDK - future)

2. **Unscoped wrapper (`orchagent`):** Convenience package for shorter `npx` commands

## Publishing Workflow

### Option 1: Automated Script (Recommended)

Use the provided script that publishes both packages and keeps versions in sync:

```bash
# Publish as latest (production)
./scripts/publish-cli-with-wrapper.sh

# Publish with a tag (beta, alpha, etc.)
./scripts/publish-cli-with-wrapper.sh beta
```

The script:
1. Builds `@orchagent/cli`
2. Publishes `@orchagent/cli`
3. Updates wrapper version to match CLI version
4. Publishes `orchagent` wrapper

### Option 2: Manual Publishing

If you need to publish manually:

```bash
# Step 1: Publish main CLI
cd cli
npm run build
npm publish --access public

# Step 2: Update wrapper version to match
CLI_VERSION=$(node -p "require('./package.json').version")
cd ../cli-wrapper
npm version "$CLI_VERSION" --no-git-tag-version --allow-same-version

# Step 3: Publish wrapper
npm publish --access public
```

## Version Management

**CRITICAL:** The wrapper version MUST always match the CLI version.

The wrapper's `package.json` uses a caret dependency:
```json
"dependencies": {
  "@orchagent/cli": "^0.3.29"
}
```

This ensures:
- ✅ `npx orchagent` always uses the latest compatible CLI version
- ✅ Users get bug fixes automatically
- ✅ No need to republish wrapper for patch releases

## Testing Before Publishing

Test the wrapper locally before publishing:

```bash
# In cli-wrapper directory
npm link

# Test the command
orchagent --version
orchagent --help

# Cleanup
npm unlink
```

## Troubleshooting

**Issue:** Wrapper package uses outdated CLI version

**Solution:** The caret dependency (`^0.3.29`) should auto-resolve to the latest. If not:
1. Bump the CLI version in wrapper's `package.json`
2. Republish the wrapper

**Issue:** Version mismatch between packages

**Solution:** Always use the publish script to keep versions in sync.

## Maintenance Burden

**Very low:** The wrapper requires minimal maintenance:
- No code changes needed (just forwards to CLI)
- Version syncing is automated via publish script
- Dependency uses caret range for auto-updates

## Future Considerations

When publishing `@orchagent/sdk` (TypeScript SDK from roadmap):
- Keep the scoped naming: `@orchagent/sdk`
- No wrapper needed (SDK is for programmatic use, not CLI)
- Users will see cohesive `@orchagent/*` namespace on npm
