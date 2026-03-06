import { describe, it, expect } from 'vitest';
import { formatUsername, formatTime } from '../src/utils';

describe('formatUsername', () => {
  it('title-cases hyphenated names', () => {
    expect(formatUsername('brave-swift-fox')).toBe('Brave Swift Fox');
    expect(formatUsername('hello')).toBe('Hello');
    expect(formatUsername('a-b')).toBe('A B');
  });
});

describe('formatTime', () => {
  it('formats seconds as M:SS', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(125)).toBe('2:05');
    expect(formatTime(3600)).toBe('60:00');
  });
});
