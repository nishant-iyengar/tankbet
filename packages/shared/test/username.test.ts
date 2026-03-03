import { describe, it, expect } from 'vitest';
import { generateUsername } from '../src/username';

describe('generateUsername', () => {
  it('matches adjective-adjective-noun pattern', () => {
    for (let i = 0; i < 20; i++) {
      const name = generateUsername();
      expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    }
  });

  it('produces non-empty segments from valid word lists', () => {
    for (let i = 0; i < 20; i++) {
      const name = generateUsername();
      const parts = name.split('-');
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(part.length).toBeGreaterThan(0);
      }
    }
  });
});
