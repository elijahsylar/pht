import { describe, expect, it } from 'vitest';
import { isMilestone, keyAction } from './keys';

describe('keyAction', () => {
  it('maps 1–9, N and ?', () => {
    expect(keyAction({ key: '1' })).toEqual({ kind: 'toggle', index: 0 });
    expect(keyAction({ key: '9' })).toEqual({ kind: 'toggle', index: 8 });
    expect(keyAction({ key: 'n' })).toEqual({ kind: 'note' });
    expect(keyAction({ key: 'N' })).toEqual({ kind: 'note' });
    expect(keyAction({ key: '?' })).toEqual({ kind: 'help' });
    expect(keyAction({ key: '[' })).toEqual({ kind: 'step', days: -1 });
    expect(keyAction({ key: ']' })).toEqual({ kind: 'step', days: 1 });
    expect(keyAction({ key: '[', altKey: true })).toBeNull();
  });

  it('ignores 0, other keys and any modifier', () => {
    expect(keyAction({ key: '0' })).toBeNull();
    expect(keyAction({ key: 'a' })).toBeNull();
    expect(keyAction({ key: '1', ctrlKey: true })).toBeNull();
    expect(keyAction({ key: '1', metaKey: true })).toBeNull();
    expect(keyAction({ key: '1', altKey: true })).toBeNull();
  });
});

describe('isMilestone', () => {
  it('is 7, 30, 60, 100 and every 100 after', () => {
    const hits = Array.from({ length: 501 }, (_, i) => i).filter(isMilestone);
    expect(hits).toEqual([7, 30, 60, 100, 200, 300, 400, 500]);
  });
});
