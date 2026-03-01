import { BET_AMOUNTS_CENTS } from '@tankbet/game-engine/constants';
import type { BetAmountCents } from './types';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

export function formatUsername(username: string): string {
  return username
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function isBetAmount(value: number): value is BetAmountCents {
  return (BET_AMOUNTS_CENTS as readonly number[]).includes(value);
}
