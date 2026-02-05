# Testing Guide: CLI Wrapper

## Pre-Publishing Tests (Local)

### 1. Basic Functionality Test

```bash
cd /Users/joe/orchagent/cli-wrapper

# Test version
node index.js --version
# Expected: 0.3.29

# Test help
node index.js --help
# Expected: Full CLI help output

# Test a real command (requires login)
node index.js whoami
# Expected: Your user/org info OR login prompt
```

### 2. Compare with Main CLI

Both should produce IDENTICAL output:

```bash
# Test wrapper
node /Users/joe/orchagent/cli-wrapper/index.js --version
node /Users/joe/orchagent/cli-wrapper/index.js --help

# Test main CLI
node /Users/joe/orchagent/cli/dist/index.js --version
node /Users/joe/orchagent/cli/dist/index.js --help

# Compare (should be identical)
diff <(node /Users/joe/orchagent/cli-wrapper/index.js --help) \
     <(node /Users/joe/orchagent/cli/dist/index.js --help)
# Expected: No differences
```

### 3. Test via npm link (Simulates Global Install)

```bash
# Link the wrapper locally
cd /Users/joe/orchagent/cli-wrapper
npm link

# Test the orchagent command
which orchagent
# Expected: ~/.nvm/versions/node/vXX.X.X/bin/orchagent (or similar)

orchagent --version
# Expected: 0.3.29

orchagent --help
# Expected: Full help output

# Test a real command
orchagent whoami

# Cleanup
npm unlink -g orchagent
```

## Post-Publishing Tests (Production)

### 1. Test npx Usage (No Installation)

```bash
# Create clean test directory
mkdir -p /tmp/test-orchagent && cd /tmp/test-orchagent

# Test short form (wrapper)
npx orchagent@latest --version
npx orchagent@latest --help

# Test long form (main package)
npx @orchagent/cli@latest --version
npx @orchagent/cli@latest --help

# Compare versions (MUST match)
echo "Wrapper version:"
npx orchagent@latest --version
echo "Main CLI version:"
npx @orchagent/cli@latest --version

# Cleanup
cd ~ && rm -rf /tmp/test-orchagent
```

### 2. Test Global Installation

```bash
# Install via wrapper name
npm install -g orchagent

# Verify it works
orchagent --version
which orchagent

# Uninstall
npm uninstall -g orchagent

# Install via main package name
npm install -g @orchagent/cli

# Verify
orch --version
orchagent --version
which orch

# Cleanup
npm uninstall -g @orchagent/cli
```

### 3. Test Real Operations

```bash
# Test with wrapper
npx orchagent login
npx orchagent whoami
npx orchagent agents --json | head -20

# Test with main package
npx @orchagent/cli login
npx @orchagent/cli whoami
npx @orchagent/cli agents --json | head -20

# Both should work identically
```

### 4. Verify Package Metadata

```bash
# Check wrapper package
npm view orchagent
npm view orchagent version
npm view orchagent dependencies

# Check main package
npm view @orchagent/cli
npm view @orchagent/cli version

# Verify version sync
WRAPPER_VERSION=$(npm view orchagent version)
CLI_VERSION=$(npm view @orchagent/cli version)

if [ "$WRAPPER_VERSION" = "$CLI_VERSION" ]; then
  echo "✓ Versions match: $WRAPPER_VERSION"
else
  echo "✗ Version mismatch!"
  echo "  Wrapper: $WRAPPER_VERSION"
  echo "  CLI: $CLI_VERSION"
  exit 1
fi
```

## Automated Test Script

Create this as `/Users/joe/orchagent/scripts/test-wrapper.sh`:

```bash
#!/bin/bash
set -e

echo "========================================="
echo "Testing CLI Wrapper"
echo "========================================="
echo

# Test 1: Local functionality
echo "[1/5] Testing local wrapper..."
cd /Users/joe/orchagent/cli-wrapper
VERSION=$(node index.js --version)
echo "✓ Wrapper version: $VERSION"
echo

# Test 2: Compare with main CLI
echo "[2/5] Comparing outputs..."
WRAPPER_HELP=$(node index.js --help)
CLI_HELP=$(node ../cli/dist/index.js --help)
if [ "$WRAPPER_HELP" = "$CLI_HELP" ]; then
  echo "✓ Help output matches"
else
  echo "✗ Help output differs!"
  exit 1
fi
echo

# Test 3: Check dependency resolution
echo "[3/5] Checking dependency..."
if [ -d "node_modules/@orchagent/cli" ]; then
  echo "✓ Dependency installed"
else
  echo "✗ Dependency missing!"
  exit 1
fi
echo

# Test 4: Verify executability
echo "[4/5] Checking executable..."
if [ -x "index.js" ]; then
  echo "✓ index.js is executable"
else
  echo "✗ index.js not executable!"
  exit 1
fi
echo

# Test 5: Version sync check
echo "[5/5] Checking version sync..."
WRAPPER_VERSION=$(node -p "require('./package.json').version")
CLI_VERSION=$(node -p "require('../cli/package.json').version")
if [ "$WRAPPER_VERSION" = "$CLI_VERSION" ]; then
  echo "✓ Versions match: $WRAPPER_VERSION"
else
  echo "✗ Version mismatch!"
  echo "  Wrapper: $WRAPPER_VERSION"
  echo "  CLI: $CLI_VERSION"
  exit 1
fi
echo

echo "========================================="
echo "✓ All tests passed!"
echo "========================================="
```

## Critical Verification Checklist

Before publishing, verify:

- [ ] ✅ Wrapper `package.json` version matches CLI version
- [ ] ✅ Wrapper `index.js` is executable (`chmod +x`)
- [ ] ✅ Wrapper has correct dependency: `"@orchagent/cli": "^0.3.29"`
- [ ] ✅ Local test: `node index.js --version` works
- [ ] ✅ Local test: `node index.js --help` shows full help
- [ ] ✅ npm link test: `orchagent --version` works globally
- [ ] ✅ README.md explains wrapper relationship clearly
- [ ] ✅ `.npmignore` configured (excludes `node_modules`, logs)

After publishing, verify:

- [ ] ✅ `npm view orchagent version` matches `npm view @orchagent/cli version`
- [ ] ✅ `npx orchagent --version` works without installation
- [ ] ✅ `npx @orchagent/cli --version` still works
- [ ] ✅ Both commands show identical output
- [ ] ✅ Authentication works with both commands
- [ ] ✅ File uploads work with both commands
- [ ] ✅ All flags/options work identically

## Troubleshooting

### Issue: "Cannot find module '@orchagent/cli'"

**Cause:** Dependencies not installed in wrapper directory

**Fix:**
```bash
cd /Users/joe/orchagent/cli-wrapper
npm install
```

### Issue: Version mismatch between packages

**Cause:** Wrapper version not updated after CLI bump

**Fix:**
```bash
cd /Users/joe/orchagent/cli-wrapper
CLI_VERSION=$(node -p "require('../cli/package.json').version")
npm version "$CLI_VERSION" --no-git-tag-version --allow-same-version
```

### Issue: "permission denied" when running wrapper

**Cause:** `index.js` not executable

**Fix:**
```bash
chmod +x /Users/joe/orchagent/cli-wrapper/index.js
```

### Issue: npx downloads wrong version

**Cause:** npm cache or registry delay

**Fix:**
```bash
# Clear npm cache
npm cache clean --force

# Wait a few minutes for registry propagation
# Then test again
npx orchagent@latest --version
```

## Production Monitoring

After publishing, monitor these metrics:

1. **Download stats:**
   ```bash
   npm view orchagent
   npm view @orchagent/cli
   ```

2. **Version consistency:**
   ```bash
   # Check every release
   npm view orchagent version
   npm view @orchagent/cli version
   ```

3. **User feedback:**
   - GitHub issues mentioning "npx orchagent"
   - Confusion about package names
   - Version mismatch reports

4. **npm audit:**
   ```bash
   cd /Users/joe/orchagent/cli-wrapper
   npm audit
   ```
