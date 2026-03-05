import type { InputState } from '@tankbet/game-engine/physics';

type KeyMap = Record<string, keyof Omit<InputState, 'fire'> | 'fire'>;

const P1_KEYS: KeyMap = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Space: 'fire',
};

const P2_KEYS: KeyMap = {
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  KeyQ: 'fire',
};

export class InputHandler {
  private keys: InputState = { up: false, down: false, left: false, right: false, fire: false };
  private seq = 0;
  private onInput: ((keys: InputState, seq: number) => void) | null = null;
  private keyMap: KeyMap = P1_KEYS;
  private handleKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private handleKeyUp: ((e: KeyboardEvent) => void) | null = null;

  attach(playerIndex: 0 | 1, onInput?: (keys: InputState, seq: number) => void): void {
    this.onInput = onInput ?? null;
    // Both players use the same keys — each player is on their own device
    this.keyMap = P1_KEYS;
    this.keys = { up: false, down: false, left: false, right: false, fire: false };
    this.seq = 0;

    this.handleKeyDown = (e: KeyboardEvent) => {
      const action = this.keyMap[e.code];
      if (action === undefined) return;
      e.preventDefault();

      if (!this.keys[action]) {
        this.keys = { ...this.keys, [action]: true };
        this.seq++;
        this.onInput?.(this.keys, this.seq);
      }
    };

    this.handleKeyUp = (e: KeyboardEvent) => {
      const action = this.keyMap[e.code];
      if (action === undefined) return;
      e.preventDefault();

      if (this.keys[action]) {
        this.keys = { ...this.keys, [action]: false };
        this.seq++;
        this.onInput?.(this.keys, this.seq);
      }
    };

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
  }

  detach(): void {
    if (this.handleKeyDown) {
      window.removeEventListener('keydown', this.handleKeyDown);
    }
    if (this.handleKeyUp) {
      window.removeEventListener('keyup', this.handleKeyUp);
    }
    this.handleKeyDown = null;
    this.handleKeyUp = null;
    this.onInput = null;
  }

  getKeys(): InputState {
    return { ...this.keys };
  }

  resetKeys(): void {
    this.keys = { up: false, down: false, left: false, right: false, fire: false };
  }

  getSeq(): number {
    return this.seq;
  }
}
