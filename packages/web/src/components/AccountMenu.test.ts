import { describe, expect, it } from 'vitest';
import { getUserInitials } from './AccountMenu.js';

describe('getUserInitials', () => {
  it('extracts first and last initials from multi-word names', () => {
    expect(getUserInitials('Ben Tsai', 'btsai@example.com')).toBe('BT');
    expect(getUserInitials('Sarah Grace Lin', 'sarah@example.com')).toBe('SL');
  });

  it('uses first two letters for single-word names and falls back to email', () => {
    expect(getUserInitials('Halley', 'halley@example.com')).toBe('HA');
    expect(getUserInitials('', 'editor@example.com')).toBe('ED');
  });
});
