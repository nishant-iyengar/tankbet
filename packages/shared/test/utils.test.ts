import { describe, it, expect } from 'vitest';
import { formatCents, formatUsername, formatTime, isBetAmount } from '../src/utils';

describe('formatCents', () => {
  it('converts cents to USD string', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(12599)).toBe('$125.99');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(-500)).toBe('-$5.00');
  });
});

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

describe('isBetAmount', () => {
  it('returns true for valid bet amounts and false for others', () => {
    expect(isBetAmount(100)).toBe(true);
    expect(isBetAmount(200)).toBe(true);
    expect(isBetAmount(500)).toBe(true);
    expect(isBetAmount(0)).toBe(false);
    expect(isBetAmount(150)).toBe(false);
    expect(isBetAmount(1000)).toBe(false);
  });
});
