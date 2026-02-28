import { PowerupType } from './constants';

export interface PowerupDef {
  type: string;
  spawnWeight: number; // relative frequency; higher = more common
  color: string;       // arena pickup color
  label: string;       // single-char canvas icon
  isWeapon: boolean;   // true = consumed on fire; false = passive/auto-effect
}

// Registry of all powerup definitions.
// Adding a new powerup requires only a new entry here — no game-loop changes.
export const POWERUP_DEFS: Record<string, PowerupDef> = {
  [PowerupType.TARGETING_MISSILE]: {
    type: PowerupType.TARGETING_MISSILE,
    spawnWeight: 1,
    color: '#f97316',
    label: 'M',
    isWeapon: true,
  },
};

// Plain-object representation of an active effect (mirrors the Colyseus ActiveEffect schema).
export interface ActiveEffectData {
  type: string;
  remainingTime: number; // seconds remaining; -1 if ammo-based
  remainingAmmo: number; // shots remaining; -1 if timed
}

export interface TankStats {
  speedMultiplier: number;
  // Future: bulletSpeedMultiplier, maxBulletsOverride, etc.
}

// Fold all active effects into a resolved stats object.
// Physics functions (updateTank, createBullet) are never aware of powerups —
// they only see the resolved numbers the caller passes in.
// This is the modifier-stack pattern.
export function resolveStats(effects: ActiveEffectData[]): TankStats {
  let speedMultiplier = 1;
  for (const _effect of effects) {
    // targeting_missile is weapon-only — no movement stat changes.
    // Future: case PowerupType.SPEED_BOOST: speedMultiplier *= value; break;
  }
  return { speedMultiplier };
}

// Weighted-random powerup type selection.
export function randomPowerupType(rng: () => number = Math.random): string {
  const defs = Object.values(POWERUP_DEFS);
  const totalWeight = defs.reduce((sum, d) => sum + d.spawnWeight, 0);
  let roll = rng() * totalWeight;
  for (const def of defs) {
    roll -= def.spawnWeight;
    if (roll <= 0) return def.type;
  }
  return defs[defs.length - 1]!.type;
}
