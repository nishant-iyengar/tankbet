import type { BetAmountCents } from '@tankbet/game-engine/constants';
export type { BetAmountCents };

export type GameStatus =
  | 'PENDING_ACCEPTANCE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FORFEITED'
  | 'REJECTED'
  | 'EXPIRED';

export type ContributionRole = 'WINNER' | 'LOSER';

export interface PublicUser {
  id: string;
  username: string;
  balance: number;
  totalDonatedCents: number;
}

export interface PublicCharity {
  id: string;
  name: string;
  logoUrl: string;
  description: string;
}

export interface GameInvitePreview {
  id: string;
  betAmountCents: BetAmountCents;
  creatorUsername: string;
  inviteExpiresAt: string;
  status: GameStatus;
}

export interface DonationHistoryEntry {
  gameId: string;
  role: ContributionRole;
  charityName: string;
  charityLogoUrl: string;
  betAmountCents: number;
  netAmountCents: number;
  displayAmountCents: number;
  createdAt: string;
}
