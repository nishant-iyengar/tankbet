/**
 * 18-action discrete action table matching training/action_table.py.
 * Maps action index → InputState for tank controls.
 */
import type { InputState } from '@tankbet/game-engine/physics';

// [up, down, left, right, fire]
const ACTION_TABLE: readonly [boolean, boolean, boolean, boolean, boolean][] = [
  [false, false, false, false, false], // 0:  idle
  [true,  false, false, false, false], // 1:  forward
  [false, true,  false, false, false], // 2:  backward
  [false, false, true,  false, false], // 3:  rotate left
  [false, false, false, true,  false], // 4:  rotate right
  [true,  false, true,  false, false], // 5:  forward + left
  [true,  false, false, true,  false], // 6:  forward + right
  [false, true,  true,  false, false], // 7:  backward + left
  [false, true,  false, true,  false], // 8:  backward + right
  [false, false, false, false, true],  // 9:  fire
  [true,  false, false, false, true],  // 10: forward + fire
  [false, true,  false, false, true],  // 11: backward + fire
  [false, false, true,  false, true],  // 12: left + fire
  [false, false, false, true,  true],  // 13: right + fire
  [true,  false, true,  false, true],  // 14: forward + left + fire
  [true,  false, false, true,  true],  // 15: forward + right + fire
  [false, true,  true,  false, true],  // 16: backward + left + fire
  [false, true,  false, true,  true],  // 17: backward + right + fire
];

export function decodeAction(actionIdx: number): InputState {
  const entry = ACTION_TABLE[actionIdx];
  if (!entry) {
    return { up: false, down: false, left: false, right: false, fire: false };
  }
  return {
    up: entry[0],
    down: entry[1],
    left: entry[2],
    right: entry[3],
    fire: entry[4],
  };
}
