/**
 * Tests for security scan report formatting.
 *
 * Covers BUG-3: the gateway returns nested objects for by_severity/by_category
 * ({total, leaked}) but the CLI originally expected flat numbers, causing
 * empty report sections.
 *
 * Covers P-3: "By Severity" and "By Category" sections render empty when all
 * leaked counts are 0 but the gateway still sends category/severity entries.
 */

import { describe, it, expect } from 'vitest'
import { extractCount, generateMarkdownReport } from './security'

describe('extractCount', () => {
  it('handles a flat number', () => {
    expect(extractCount(5)).toBe(5)
  })

  it('handles zero', () => {
    expect(extractCount(0)).toBe(0)
  })

  it('extracts leaked from nested object', () => {
    expect(extractCount({ total: 3, leaked: 2 })).toBe(2)
  })

  it('returns 0 for nested object with no leaks', () => {
    expect(extractCount({ total: 5, leaked: 0 })).toBe(0)
  })

  it('handles nested object where all attacks leaked', () => {
    expect(extractCount({ total: 10, leaked: 10 })).toBe(10)
  })
})

describe('generateMarkdownReport', () => {
  const baseScanResult = {
    agent_id: 'test-org/test-agent',
    scanned_at: '2026-02-07T00:00:00Z',
    total_attacks: 35,
    vulnerabilities_found: 1,
    risk_level: 'CRITICAL',
    vulnerabilities: [
      {
        attack_id: 'atk-1',
        attack_name: 'Error recovery exploit',
        attack_description: 'Exploits error recovery behavior',
        category: 'advanced',
        severity: 'critical',
        confidence: 0.95,
      },
    ],
    summary: {
      by_severity: {
        critical: { total: 5, leaked: 1 },
        high: { total: 10, leaked: 0 },
        medium: { total: 15, leaked: 0 },
        low: { total: 5, leaked: 0 },
      },
      by_category: {
        social_engineering: { total: 5, leaked: 0 },
        advanced: { total: 5, leaked: 1 },
        encoding_trick: { total: 5, leaked: 0 },
      },
    },
  }

  it('shows By Severity section with vulnerability counts', () => {
    const md = generateMarkdownReport(baseScanResult)
    expect(md).toContain('### By Severity')
    expect(md).toContain('CRITICAL')
  })

  it('shows By Category section with vulnerability counts', () => {
    const md = generateMarkdownReport(baseScanResult)
    expect(md).toContain('### By Category')
    expect(md).toContain('advanced')
  })

  it('shows severity entries even when leaked count is 0', () => {
    const result = {
      ...baseScanResult,
      vulnerabilities_found: 0,
      vulnerabilities: [],
      summary: {
        by_severity: {
          critical: { total: 5, leaked: 0 },
          high: { total: 10, leaked: 0 },
          medium: { total: 15, leaked: 0 },
        },
        by_category: {
          social_engineering: { total: 5, leaked: 0 },
          encoding_trick: { total: 5, leaked: 0 },
        },
      },
    }

    const md = generateMarkdownReport(result)

    // P-3 bug: these sections had headers but no content
    expect(md).toContain('### By Severity')
    // Should show entries even with 0 leaked
    expect(md).toMatch(/critical/i)
    expect(md).toMatch(/high/i)
    expect(md).toMatch(/medium/i)
  })

  it('shows category entries even when leaked count is 0', () => {
    const result = {
      ...baseScanResult,
      vulnerabilities_found: 0,
      vulnerabilities: [],
      summary: {
        by_severity: {},
        by_category: {
          social_engineering: { total: 5, leaked: 0 },
          encoding_trick: { total: 5, leaked: 0 },
        },
      },
    }

    const md = generateMarkdownReport(result)
    expect(md).toContain('### By Category')
    expect(md).toContain('social_engineering')
    expect(md).toContain('encoding_trick')
  })
})
