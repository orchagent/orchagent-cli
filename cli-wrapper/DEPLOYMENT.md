# Deployment Checklist: CLI Wrapper

## Pre-Deployment Checklist

### 1. Verify Local Tests Pass

```bash
./scripts/test-wrapper.sh
```

Expected output: `✓ All tests passed!`

### 2. Verify npm Login

```bash
npm whoami
```

Expected: Your npm username (e.g., `joe` or org account)

### 3. Verify Version Sync

```bash
# CLI version
cat cli/package.json | grep version

# Wrapper version
cat cli-wrapper/package.json | grep version
```

Expected: Both show `"version": "0.3.29"` (or same version)

### 4. Verify Build

```bash
cd cli
npm run build
ls -la dist/index.js
```

Expected: `dist/index.js` exists and is recent

### 5. Check Git Status

```bash
git status
```

Expected: All wrapper files committed (or staged for commit)

## Deployment Steps

### Option 1: Automated Script (Recommended)

```bash
# From repo root
./scripts/publish-cli-with-wrapper.sh

# Or with tag
./scripts/publish-cli-with-wrapper.sh beta
```

This will:
1. Build @orchagent/cli
2. Publish @orchagent/cli
3. Update wrapper version
4. Publish orchagent wrapper

### Option 2: Manual Deployment

```bash
# Step 1: Publish main CLI
cd /Users/joe/orchagent/cli
npm run build
npm publish --access public

# Step 2: Update and publish wrapper
cd /Users/joe/orchagent/cli-wrapper
CLI_VERSION=$(node -p "require('../cli/package.json').version")
npm version "$CLI_VERSION" --no-git-tag-version --allow-same-version
npm publish --access public
```

## Post-Deployment Verification

### 1. Verify Packages Published

```bash
# Check wrapper
npm view orchagent

# Check main package
npm view @orchagent/cli
```

Expected: Both show latest version

### 2. Verify Version Sync

```bash
npm view orchagent version
npm view @orchagent/cli version
```

Expected: Both show same version (e.g., `0.3.29`)

### 3. Test npx (Short Form)

```bash
# Create clean test environment
mkdir -p /tmp/test-orchagent-deploy && cd /tmp/test-orchagent-deploy

# Test wrapper
npx orchagent@latest --version
npx orchagent@latest --help

# Cleanup
cd ~ && rm -rf /tmp/test-orchagent-deploy
```

Expected: Version and help output display correctly

### 4. Test npx (Long Form)

```bash
mkdir -p /tmp/test-orchagent-deploy && cd /tmp/test-orchagent-deploy

# Test main package
npx @orchagent/cli@latest --version
npx @orchagent/cli@latest --help

cd ~ && rm -rf /tmp/test-orchagent-deploy
```

Expected: Same version and help as wrapper

### 5. Compare Both Outputs

```bash
mkdir -p /tmp/test-orchagent-deploy && cd /tmp/test-orchagent-deploy

# Get versions
WRAPPER_VER=$(npx orchagent@latest --version 2>/dev/null)
CLI_VER=$(npx @orchagent/cli@latest --version 2>/dev/null)

echo "Wrapper version: $WRAPPER_VER"
echo "CLI version: $CLI_VER"

if [ "$WRAPPER_VER" = "$CLI_VER" ]; then
  echo "✓ Versions match!"
else
  echo "✗ Version mismatch!"
fi

cd ~ && rm -rf /tmp/test-orchagent-deploy
```

Expected: `✓ Versions match!`

### 6. Test Real Command

```bash
# Test skill install (safe dry-run)
npx orchagent skill install --help

# Test agents list
npx orchagent agents --help
```

Expected: Help text displays correctly

### 7. Verify Package Pages

Visit these URLs in browser:
- https://www.npmjs.com/package/orchagent
- https://www.npmjs.com/package/@orchagent/cli

Expected:
- Both pages exist
- Both show same version
- READMEs display correctly
- Dependencies listed correctly

## Rollback Procedure

If something goes wrong, rollback within 72 hours:

### 1. Unpublish Wrapper (if needed)

```bash
npm unpublish orchagent@0.3.29 --force
```

⚠️ **Warning:** Only works within 72 hours of publish

### 2. Revert Documentation

```bash
cd /Users/joe/orchagent
git checkout HEAD -- docs/cli.md README.md
```

### 3. Notify Users

If users already tried the wrapper, communicate:
- Wrapper temporarily unavailable
- Use `npx @orchagent/cli` instead
- Investigating issue

## Common Issues

### Issue: npm publish fails with 403

**Cause:** Not logged in or no publish permissions

**Fix:**
```bash
npm login
npm whoami
# Verify you're logged in as correct user
```

### Issue: Version already published

**Cause:** Trying to republish same version

**Fix:**
```bash
# Bump version first
cd cli
npm version patch  # or minor, or major
npm publish

# Then wrapper auto-updates via postpublish hook
```

### Issue: Wrapper shows old CLI version

**Cause:** npm registry caching

**Fix:**
- Wait 5-10 minutes for registry propagation
- Clear npm cache: `npm cache clean --force`
- Test again: `npx orchagent@latest --version`

### Issue: "Cannot find module @orchagent/cli"

**Cause:** Wrapper published before main CLI

**Fix:**
- Always publish main CLI first
- Then publish wrapper
- Use automated script to ensure correct order

## Monitoring After Deployment

### Week 1: Active Monitoring

Check daily:

1. **Download stats:**
   ```bash
   npm view orchagent
   ```

2. **GitHub issues:**
   - Search for "npx orchagent"
   - Look for confusion/bugs

3. **npm audit:**
   ```bash
   cd /Users/joe/orchagent/cli-wrapper
   npm audit
   ```

### Week 2+: Periodic Checks

Check weekly:
- Version sync between packages
- Download trends
- User feedback

## Future Releases

For subsequent releases, the process is even simpler:

### With Automated Hook (Already Configured)

```bash
cd /Users/joe/orchagent/cli

# Bump version
npm version patch  # or minor, or major

# Publish (wrapper auto-publishes)
npm publish --access public
```

The `postpublish` hook in `cli/package.json` automatically:
1. Updates wrapper version to match
2. Publishes wrapper to npm
3. Reports success

### Or Use Script

```bash
./scripts/publish-cli-with-wrapper.sh
```

## Success Criteria

Deployment is successful when:

- [x] ✅ Both packages published to npm
- [x] ✅ Versions match exactly
- [x] ✅ `npx orchagent` works without installation
- [x] ✅ `npx @orchagent/cli` still works
- [x] ✅ Both commands show identical output
- [x] ✅ Help text displays correctly
- [x] ✅ README visible on npm package pages
- [x] ✅ No errors in npm audit

## Emergency Contacts

If deployment goes wrong:

1. **Unpublish within 72 hours** (npm restriction)
2. **Check npm status:** https://status.npmjs.org/
3. **npm support:** https://www.npmjs.com/support
4. **Revert docs to stable state**
5. **Communicate status to users**

## Next Deployment

Version: 0.3.30 (or next version)

Pre-deployment checklist:
- [ ] Run `./scripts/test-wrapper.sh`
- [ ] Verify git status clean
- [ ] Commit wrapper files
- [ ] Run `./scripts/publish-cli-with-wrapper.sh`
- [ ] Verify deployment checklist
- [ ] Monitor for 24-48 hours
