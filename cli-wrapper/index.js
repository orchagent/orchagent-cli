#!/usr/bin/env node

/**
 * Thin wrapper for @orchagent/cli
 *
 * This package exists to provide a shorter npx command:
 *   npx orchagent skill install org/skill
 *
 * Instead of:
 *   npx @orchagent/cli skill install org/skill
 *
 * All functionality is provided by @orchagent/cli.
 */

require('@orchagent/cli/dist/index.js');
