import { expect, it } from 'vitest'
import { descriptors, parseRequest, parseView } from '../src/bridge.ts'
import { parseBackup } from '../src/bff.ts'
it('strictly decodes transport identities and public metadata without leaking extra fields', () => {
  expect(parseView(null)).toBeNull()
  expect(parseBackup({ backup: null })).toBeNull()
  expect(() => parseRequest({ sessionId: 'invalid' })).toThrow()
  expect(() => parseView({ sessionId: 'invalid', token: 'FAKE_TEST_ONLY' })).toThrow()
  expect(() => parseBackup({ backup: { sha256: 'a'.repeat(64), size: 1, format: 'dsh-session-tree-tar-gzip', uploadedAtMs: null, objectKey: 'private' } })).toThrow()
  expect(() => parseBackup({ backup: { sha256: 'invalid', size: 1, format: 'dsh-session-tree-tar-gzip', uploadedAtMs: null } })).toThrow()
  expect(descriptors.every(value => value.result.decode === parseView)).toBe(true)
})

it('requires and validates both public sync timestamps independently', () => {
  const view = { sessionId: '5bceb58e-601f-5e17-9607-32d954f16455', taskId: 21, runId: 31, bindingEpoch: 1, revision: 1, phase: 'synced', uploadedAtMs: 1234, lastSyncedAtMs: 20_000 }
  expect(parseView(view)).toEqual(view)
  expect(parseView({ ...view, uploadedAtMs: null, lastSyncedAtMs: null })).toMatchObject({ uploadedAtMs: null, lastSyncedAtMs: null })
  for (const field of ['uploadedAtMs', 'lastSyncedAtMs']) {
    for (const invalid of [undefined, -1, 0, 1.5, NaN, Infinity, '1234']) expect(() => parseView({ ...view, [field]: invalid })).toThrow('invalid sync timestamp')
  }
  const { lastSyncedAtMs, ...legacy } = view
  expect(() => parseView(legacy)).toThrow('invalid sync view')
  expect(() => parseView({ ...view, privateToken: 'TEST_ONLY' })).toThrow('invalid sync view')
})
