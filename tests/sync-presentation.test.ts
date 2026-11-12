import { expect, it } from 'vitest'
import { formatLastSync } from '../src/client/sync-presentation.ts'

const uploadedAtMs = 1_700_000_000_000
it.each([
  [null, uploadedAtMs, '尚未同步'],
  [uploadedAtMs, uploadedAtMs - 10_000, '上次同步 · 0s 前'],
  [uploadedAtMs, uploadedAtMs, '上次同步 · 0s 前'],
  [uploadedAtMs, uploadedAtMs + 999, '上次同步 · 0s 前'],
  [uploadedAtMs, uploadedAtMs + 1000, '上次同步 · 1s 前'],
  [uploadedAtMs, uploadedAtMs + 59_999, '上次同步 · 59s 前'],
  [uploadedAtMs, uploadedAtMs + 60_000, '上次同步 · 1m 0s 前'],
  [uploadedAtMs, uploadedAtMs + 130_000, '上次同步 · 2m 10s 前'],
  [uploadedAtMs, uploadedAtMs + 3_599_000, '上次同步 · 59m 59s 前'],
  [uploadedAtMs, uploadedAtMs + 3_600_000, '上次同步 · 1h 0m 0s 前'],
  [uploadedAtMs, uploadedAtMs + 90_061_000, '上次同步 · 25h 1m 1s 前'],
])('formats server backup %s at wall time %s', (backup, now, expected) => {
  expect(formatLastSync(backup, now)).toBe(expected)
})
