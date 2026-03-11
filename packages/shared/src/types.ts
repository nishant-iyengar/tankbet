export type GameStatus =
  | 'PENDING_ACCEPTANCE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FORFEITED'
  | 'REJECTED'
  | 'EXPIRED';

export interface PublicUser {
  id: string;
  username: string;
}

export interface GameInvitePreview {
  id: string;
  creatorUsername: string;
  inviteExpiresAt: string;
  status: GameStatus;
}

export interface ActiveGameInfo {
  gameId: string;
  inviteToken: string;
  status: 'PENDING_ACCEPTANCE' | 'IN_PROGRESS';
}

export interface GameHistoryEntry {
  id: string;
  opponentUsername: string;
  result: 'WON' | 'LOST' | null;
  durationSeconds: number | null;
  status: GameStatus;
  endedAt: string | null;
  createdAt: string;
}

export interface GameHistoryResponse {
  entries: GameHistoryEntry[];
  nextCursor: string | null;
}
