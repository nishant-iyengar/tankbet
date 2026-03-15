# Training a Tank Bot with Double DQN: Complete Implementation Guide

> **Implementation grounded in:** [johnnycode8/dqn_pytorch](https://github.com/johnnycode8/dqn_pytorch) — a clean, proven PyTorch Double DQN + Dueling DQN implementation tested on CartPole and Flappy Bird.

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Algorithm Deep Dive: Double DQN](#2-algorithm-deep-dive-double-dqn)
3. [Python Training Environment (Gymnasium)](#3-python-training-environment-gymnasium)
4. [Neural Network Architecture](#4-neural-network-architecture)
5. [State Encoding](#5-state-encoding)
6. [Action Space](#6-action-space)
7. [Reward Function](#7-reward-function)
8. [Replay Buffer](#8-replay-buffer)
9. [Training Loop](#9-training-loop)
10. [Self-Play](#10-self-play)
11. [Export & Server Deployment](#11-export--server-deployment)
12. [Hyperparameter Reference](#12-hyperparameter-reference)
13. [Research Sources](#13-research-sources)

---

## 1. Architecture Overview

### The Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│  TRAINING (Python, custom PyTorch)                              │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Gymnasium    │───▶│ Custom       │───▶│ Trained      │      │
│  │  Environment  │    │ DDQN Agent   │    │ PyTorch      │      │
│  │  (game physics│◀───│ (PyTorch)    │    │ Model (.pt)  │      │
│  │   in Python)  │    │              │    │              │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│                                                  │              │
│                                          torch.onnx.export()   │
│                                                  │              │
│                                          ┌───────▼───────┐     │
│                                          │  model.onnx    │     │
│                                          │  (~200-650KB)  │     │
│                                          └───────┬───────┘     │
└──────────────────────────────────────────────────┼─────────────┘
                                                   │
┌──────────────────────────────────────────────────┼─────────────┐
│  INFERENCE (TypeScript, Node.js server)          │             │
│                                                  │             │
│  ┌──────────────┐    ┌──────────────┐    ┌───────▼───────┐    │
│  │  Game State   │───▶│ onnxruntime  │───▶│  Action       │    │
│  │  (encode to   │    │ -node        │    │  (argmax of   │    │
│  │   tensor)     │    │ (native C++) │    │   Q-values)   │    │
│  └──────────────┘    └──────────────┘    └───────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Library | Why |
|-----------|---------|-----|
| Package manager | [uv](https://docs.astral.sh/uv/) | Rust-based, 10-100× faster than pip, deterministic lockfile (`uv.lock`) |
| Training | Custom PyTorch | SB3's DQN is intentionally minimal in its own docs; custom code gives full control over Double/Dueling/PER and game-specific wiring. |
| Environment | [Gymnasium](https://gymnasium.farama.org/) | Universal RL environment API, clean `reset()`/`step()` interface |
| Neural network | [PyTorch](https://pytorch.org/) | Industry standard, clean tensor ops, built-in ONNX export |
| Model export | [torch.onnx](https://pytorch.org/docs/stable/onnx_export.html) | PyTorch's built-in ONNX export (works with both "legacy" and newer exporter paths depending on your PyTorch version) |
| Server inference | [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node) | Native ONNX runtime for Node.js (server-side bot) |

### Why NOT Stable Baselines3?

SB3's documentation explicitly states (verify on the linked page if you're reading this in the future; these details can change between SB3 releases):

> *"This implementation provides only vanilla Deep Q-Learning and has no extensions such as Double-DQN, Dueling-DQN and Prioritized Experience Replay."*
> — [SB3 DQN docs](https://stable-baselines3.readthedocs.io/en/master/modules/dqn.html)

We need Double DQN + Dueling DQN. Writing a custom agent in pure PyTorch (~200 lines) is the proven approach — this is exactly what [johnnycode8/dqn_pytorch](https://github.com/johnnycode8/dqn_pytorch) does, and it trained a Flappy Bird agent to score 100+ pipes.

### Why Python for Training?

- PyTorch's autograd handles all gradient computation
- Gymnasium is the universal standard for RL environments
- The game physics must be reimplemented in Python as a headless Gymnasium environment — this is standard practice
- After training, export to ONNX and run inference in Node.js via `onnxruntime-node`

### Python Dependencies (uv)

We use [**uv**](https://docs.astral.sh/uv/) (by Astral, makers of ruff) for Python package management. It's a Rust-based drop-in replacement for pip + venv that is 10-100× faster, creates a deterministic lockfile (`uv.lock`), and handles Python version management.

```bash
# Install uv (once, system-wide — skip if already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Initialize the training project with a "boring" Python version
# (PyTorch wheels sometimes lag the newest CPython releases).
cd tankbet/training
uv init --python 3.12

# Install all dependencies (creates .venv/ automatically + uv.lock)
uv add torch gymnasium tensorboard numpy moviepy pygame imageio-ffmpeg
```

To run any Python command inside the managed environment, prefix with `uv run`:

```bash
uv run python agent.py            # train
uv run tensorboard --logdir runs/  # monitor
```

Or activate the venv manually (same as traditional workflow):

```bash
source .venv/bin/activate
python agent.py
```

No CUDA required. Start on CPU for simplicity; if you do use CUDA later, avoid storing replay buffer tensors on GPU (see training loop notes below).

### Shared Constants (Python ↔ TypeScript)

Game constants (tank speed, bullet speed, maze dimensions, etc.) are defined in a **single JSON file** — `packages/game-engine/src/constants.json` — that both TypeScript and Python read:

- **TypeScript:** `constants.ts` imports `constants.json` and re-exports with types
- **Python:** `tank_env.py` loads the same JSON file at startup via `__init_constants()`

This ensures the training environment always uses identical physics parameters to the production game. When you change a constant (e.g., double bullet speed), bump `ENV_VERSION` in the JSON — this invalidates old models and forces retraining.

### Project Structure

The `training/` directory is a standalone Python project. It reads constants from `packages/game-engine/src/constants.json` but does NOT import TypeScript code — the physics are ported manually to Python in `tank_env.py`. The only artifact that crosses the Python → TypeScript boundary is the exported `tank_bot.onnx` file.

```
tankbet/
├── apps/
│   ├── web/                          # React frontend (existing)
│   └── backend/                      # Fastify + Colyseus server (existing)
│       └── src/bot/                  # TypeScript inference (AFTER training)
│           ├── StateEncoder.ts       # Encodes game state → Float32Array(88)
│           ├── ActionDecoder.ts      # Maps action index → InputState
│           ├── BotPlayer.ts          # ONNX inference at 20Hz
│           └── tank_bot.onnx         # Trained model (copied from training/)
│
├── packages/
│   ├── game-engine/                  # Shared physics/constants (existing)
│   │   └── src/constants.json        # ← SINGLE SOURCE OF TRUTH for game constants
│   └── shared/                       # Shared types (existing)
│
├── training/                         # Python training (NEW — entirely separate)
│   ├── .venv/                        # Python virtual environment (gitignored)
│   ├── tank_env.py                   # Gymnasium environment (ports TS physics)
│   ├── dqn.py                        # Dueling DQN network (PyTorch)
│   ├── experience_replay.py          # ReplayMemory (deque)
│   ├── agent.py                      # Training loop (the Agent class)
│   ├── self_play.py                  # SelfPlayEnv wrapper
│   ├── export_onnx.py                # PyTorch → ONNX export script
│   ├── pyproject.toml                # Python project config (PEP 621) — deps declared here
│   ├── uv.lock                       # Deterministic lockfile (auto-generated by uv)
│   └── runs/                         # Training artifacts (gitignored)
│       └── v1/                       # Organized by ENV_VERSION
│           ├── constants_snapshot.json   # Frozen constants at training start
│           ├── tb_logs/                  # TensorBoard logs
│           ├── training_state.pt         # Resumable checkpoint
│           ├── ddqn_tankbet-v1_latest.pt # Latest model weights
│           ├── ddqn_tankbet-v1_best.pt   # Best model (highest episode reward)
│           ├── checkpoints/              # Opponent pool for self-play
│           └── videos/                   # Recorded gameplay
│
├── docs/
│   └── DDQN_TRAINING_GUIDE.md       # This guide
│
└── .gitignore                        # Add: training/.venv/, training/runs/
```

### What Gets Committed vs Gitignored

| Path | Git? | Why |
|------|------|-----|
| `training/*.py` | Committed | Source code |
| `training/pyproject.toml` | Committed | Project config + dependency declarations |
| `training/uv.lock` | Committed | Deterministic lockfile (reproducible installs) |
| `training/.venv/` | **Gitignored** | Local Python env |
| `training/runs/` | **Gitignored** | Model checkpoints, videos, TensorBoard logs (large files) |
| `apps/backend/src/bot/*.ts` | Committed | Inference code |
| `apps/backend/src/bot/tank_bot.onnx` | Committed | The final trained model (~200-650KB, small enough for git) |

---

## 2. Algorithm Deep Dive: Double DQN

### What the Network Learns

The network learns **Q(s, a)** — the expected total future reward for taking action `a` in state `s`.

- **Input:** game state (~88 numbers — tank positions, bullets, walls, lives)
- **Output:** 18 numbers — one Q-value per possible action
- **To act:** pick the action with the highest Q-value

### The Bellman Equation

The single formula that drives all of DQN:

```
Q(s, a) = reward + γ × max Q(s', a')
         ───┬───   ──┬──   ─────┬─────
            │        │          │
     "what I got"  "discount" "best future value"
```

Training = make the network's predictions satisfy this equation. The gap between prediction and target is the **TD error**, and gradient descent minimizes it.

### Standard DQN's Problem: Overestimation

Standard DQN uses the same network to both **select** the best next action and **evaluate** its value:

```python
# Standard DQN target (overestimates)
target = reward + gamma * target_network(next_state).max(dim=1)[0]
#                                                    ^^^
#                         max over noisy estimates is biased upward
```

If one action's Q-value is accidentally high due to noise, `max` selects it, and the error propagates through training. Over thousands of updates, Q-values systematically inflate.

**Source:** van Hasselt, Guez, Silver — *"Deep Reinforcement Learning with Double Q-learning"* (2015), [arXiv:1509.06461](https://arxiv.org/abs/1509.06461). Published AAAI 2016.

### Double DQN: The Fix

Decouple action **selection** from action **evaluation** using two networks. From [johnnycode8/dqn_pytorch](https://github.com/johnnycode8/dqn_pytorch):

```python
# Double DQN target (from agent.py optimize method)
if self.enable_double_dqn:
    # Step 1: POLICY (online) network SELECTS the best action
    best_actions = policy_dqn(new_states).argmax(dim=1)

    # Step 2: TARGET network EVALUATES that action's Q-value
    target_q = rewards + (1 - terminations) * gamma * \
        target_dqn(new_states).gather(dim=1, index=best_actions.unsqueeze(dim=1)).squeeze()
else:
    # Standard DQN: target network both selects AND evaluates
    target_q = rewards + (1 - terminations) * gamma * \
        target_dqn(new_states).max(dim=1)[0]
```

The online network picks which action looks best. The target network (a stale copy) evaluates that action's value. Since the two networks have different noise patterns, the overestimation bias largely cancels out.

**Results:** Road Runner: 233% → 617% of human performance. A one-line code change.

### Target Network: Why Two Networks?

The Bellman equation is self-referential — you train Q toward a target that depends on Q itself. If Q changes every gradient step, the target is a moving goalpost.

**Fix:** Keep a frozen copy of the network (the "target network"). Update it periodically via hard copy:

```python
# Hard update: copy weights every N steps (standard for DQN)
if step_count > network_sync_rate:
    target_dqn.load_state_dict(policy_dqn.state_dict())
    step_count = 0
```

**Standard values from johnnycode8:**
- CartPole: sync every **100 steps**
- Flappy Bird: sync every **10 steps**
- Original DQN (Mnih et al. 2015): every **10,000 steps**

For our tank game (~6,000 decisions per episode — 5 rounds × ~60s × 20Hz — more complex than CartPole but simpler than Atari): **sync every 1,000 steps** is a reasonable starting point.

**Source:** Mnih et al. — *"Human-level control through deep reinforcement learning"* (2015), [Nature](https://www.nature.com/articles/nature14236).

### Dueling Architecture: Separating Value from Advantage

Instead of outputting Q(s,a) directly, split the network into two streams:

```
                    ┌─── Value stream ──── V(s) ────────┐
Shared layers ──────┤                                    ├──▶ Q(s,a) = V(s) + A(s,a) - mean(A)
                    └─── Advantage stream ─ A(s,a) ─────┘
```

- **V(s):** "how good is this state overall?" (1 number)
- **A(s,a):** "how much better is action `a` than average?" (18 numbers)
- **Q(s,a) = V(s) + A(s,a) - mean(A):** the subtraction ensures identifiability

**Why this helps:** Many states have similar value regardless of action (e.g., opponent is far away — any move is roughly equal). The dueling architecture can learn "this state is good/bad" without needing to evaluate every action individually.

**Source:** Wang et al. — *"Dueling Network Architectures for Deep Reinforcement Learning"* (2015), [arXiv:1511.06581](https://arxiv.org/abs/1511.06581). Best Paper at ICML 2016.

### Component Summary: What We're Using

| Component | Paper | What It Does | Included? |
|-----------|-------|-------------|-----------|
| **Double DQN** | van Hasselt 2015 | Reduces Q-value overestimation | Yes |
| **Dueling Networks** | Wang 2015 | Separates state value from action advantage | Yes |
| Prioritized Replay | Schaul 2015 | Focuses learning on surprising transitions | No — start simple, add later if needed |
| Distributional RL (C51) | Bellemare 2017 | Models full return distribution | No |
| Noisy Networks | Fortunato 2017 | Learned exploration noise | No |
| N-step Returns | Sutton 1988 | Multi-step TD targets | No |

**Source:** Hessel et al. — *"Rainbow: Combining Improvements in Deep Reinforcement Learning"* (2017), [arXiv:1710.02298](https://arxiv.org/abs/1710.02298).

---

## 3. Python Training Environment (Gymnasium)

The game physics must be reimplemented in Python as a [Gymnasium](https://gymnasium.farama.org/) environment.

### Episode Structure: Full Games, Not Individual Rounds

Each episode is a **full game** (up to 5 rounds), not a single round. This is critical because:

- The agent must learn **life-count-aware strategy** — play aggressive when ahead 4-1, play conservative when behind 1-4
- Round-level episodes would make every round look identical regardless of game context
- The terminal reward (+10 win / -10 loss) only makes sense at the game level
- The per-kill reward (+3/-3) already provides round-level learning signal
- An episode ends when one player reaches 0 lives, or the 2-minute time limit is hit

Between rounds, `_new_round()` instantly generates a new maze and respawns both tanks. Unlike the real game (which has a 1.5s `resolving` phase with a visual transition), the training environment skips this pause entirely — no physics ticks run between rounds, no rewards accumulate, and no training updates happen during dead time. The agent should only learn from active gameplay, never from idle transitions. The next `step()` call immediately begins the new round.

### Why Different Mazes Every Episode (Not a Fixed Map)

Each episode generates a **new random maze** via `_generate_maze()`. This is critical — do NOT train on a single fixed maze. Research is unambiguous:

- **Cobbe et al. (2020, Procgen Benchmark, ICML):** RL agents trained on fixed levels "strongly overfit" — performance collapsed on unseen levels. Maze environments are the **worst offenders**, requiring 10,000+ training levels to close the generalization gap.
- **Zhang et al. (2018):** Deep RL agents trained on fixed 2D environments "merely memorize action sequences rather than learning general strategies."
- **OpenAI (2019, Domain Randomization):** Randomizing environment parameters forces the agent to learn robust, generalizable policies.

Our approach: generate a new DFS maze each episode using `self.np_random` (seeded for reproducibility). The seed ensures the same *sequence* of mazes across runs (reproducible), but each episode gets a *different* maze (generalizable).

**Evaluation:** Use a held-out set of fixed-seed mazes (e.g., 100 mazes generated with seeds 10000-10099) to measure true generalization performance. Never evaluate on training mazes.

**Sources:** Cobbe, Hesse, Hilton, Schulman — *"Leveraging Procedural Generation to Benchmark RL"* (2020), [arXiv:1912.01588](https://arxiv.org/abs/1912.01588). Zhang et al. — *"A Study on Overfitting in Deep RL"* (2018), [arXiv:1804.06893](https://arxiv.org/abs/1804.06893).

### Tie Window: Matching Server Semantics

The real game uses a **4-second tie window** (`TIE_WINDOW_MS = 4000`):

1. **First death:** Record who died, start a 4-second timer. The dead tank stays dead but the game continues — the surviving player keeps moving and firing.
2. **Second death within 4 seconds:** **TIE** — no lives are decremented for either player. Both respawn on a new maze.
3. **Timer expires without second death:** The first-to-die player loses a life. Check for game end, otherwise new round.

This is critical because it changes the strategic calculus: after killing the opponent, you have 4 seconds where a "revenge kill" (e.g., from a bullet already in flight) would nullify your kill. The agent must learn to survive after scoring a kill.

### Environment Structure

```python
import gymnasium as gym
from gymnasium import spaces
import numpy as np

class TankBattleEnv(gym.Env):
    """
    Headless tank battle environment for RL training.
    Reimplements the core physics from packages/game-engine/src/physics.ts.
    """

    metadata = {"render_modes": ["human", "rgb_array"], "render_fps": 60}  # render_fps is cosmetic

    # --- Game constants (loaded from shared constants.json) ---
    # These are loaded from packages/game-engine/src/constants.json,
    # the SINGLE SOURCE OF TRUTH shared with the TypeScript game engine.
    # Never hardcode values here — always read from the JSON file.
    #
    # See __init_constants() below for the loader implementation.

    def __init_constants(self):
        """Load constants from the shared JSON file."""
        import json
        from pathlib import Path
        json_path = (Path(__file__).resolve().parents[1]
                     / "packages" / "game-engine" / "src" / "constants.json")
        with open(json_path) as f:
            c = json.load(f)

        self.ENV_VERSION = c["ENV_VERSION"]
        self.CELL_SIZE = c["CELL_SIZE"]
        self.MAZE_COLS = c["MAZE_COLS"]
        self.MAZE_ROWS = c["MAZE_ROWS"]
        self.CANVAS_W = self.MAZE_COLS * self.CELL_SIZE   # 1080
        self.CANVAS_H = self.MAZE_ROWS * self.CELL_SIZE   # 720
        self.TANK_WIDTH = c["TANK_WIDTH"]
        self.TANK_HEIGHT = c["TANK_HEIGHT"]
        self.BARREL_LENGTH = c["BARREL_LENGTH"]
        self.TANK_SPEED = c["TANK_SPEED"]
        self.TANK_ROTATION_SPEED = c["TANK_ROTATION_SPEED"]
        self.BULLET_SPEED = c["BULLET_SPEED"]
        self.BULLET_HIT_RADIUS = c["BULLET_HIT_RADIUS"]
        self.TANK_HITBOX_SHRINK = c["TANK_HITBOX_SHRINK"]
        self.CORNER_SHIELD_PADDING = c["CORNER_SHIELD_PADDING"]
        self.MAX_BULLETS = c["MAX_BULLETS_PER_TANK"]
        self.BULLET_LIFETIME = c["BULLET_LIFETIME_SECONDS"]
        self.LIVES_PER_GAME = c["LIVES_PER_GAME"]
        self.TICK_HZ = c["SERVER_TICK_HZ"]
        self.DT = 1.0 / self.TICK_HZ
        self.FIRE_COOLDOWN_TICKS = int(c["BULLET_FIRE_COOLDOWN_MS"] / 1000.0 * self.TICK_HZ)  # pre-compute once
        self.TIE_WINDOW_TICKS = int(c["TIE_WINDOW_MS"] / 1000.0 * self.TICK_HZ)
        self.MAZE_MIN_WALL_FRACTION = c["MAZE_MIN_WALL_FRACTION"]
        self.WALL_FRICTION = c["WALL_FRICTION"]  # 1.0 = zero slide on wall collision (1 - 1.0 = 0)
        self.BULLET_RADIUS = c["BULLET_RADIUS"]
        self.REVERSE_SPEED_FACTOR = c["REVERSE_SPEED_FACTOR"]

    DECISION_HZ = 20  # Agent decision rate (Hz)

    def __init__(self, render_mode=None, discount_factor=0.99):
        super().__init__()
        self.render_mode = render_mode
        # γ — used by PBRS shaping reward.
        # IMPORTANT: This MUST equal the agent's discount_factor (used for TD targets).
        # If they differ, the PBRS policy-invariance guarantee breaks (Ng et al. 1999).
        self.discount_factor = discount_factor
        self.__init_constants()
        assert self.TICK_HZ % self.DECISION_HZ == 0, \
            f"TICK_HZ={self.TICK_HZ} must be divisible by DECISION_HZ={self.DECISION_HZ}"
        self.DECISION_INTERVAL = self.TICK_HZ // self.DECISION_HZ  # 60 // 20 = 3
        # If you apply shaping every *physics tick* but learn with γ per *decision step*,
        # the correct per-tick discount is γ_tick = γ_step^(1/DECISION_INTERVAL).
        self.discount_factor_tick = self.discount_factor ** (1.0 / self.DECISION_INTERVAL)
        self.MAX_EPISODE_TICKS = self.TICK_HZ * 120  # 2 minutes max

        # --- Action space: 18 discrete actions (see Section 6) ---
        self.action_space = spaces.Discrete(18)

        # --- Observation space: flat float32 vector (see Section 5) ---
        # 7 (ego) + 8 (opponent, incl. bearing cos+sin) + 2 (lives) + 50 (bullets) + 18 (local walls) + 3 (metadata) = 88
        self.observation_space = spaces.Box(
            low=-1.0, high=1.0,
            shape=(88,),
            dtype=np.float32,
        )

        # Internal state
        self._maze = None
        self._wall_segments = []
        self._wall_endpoints = []  # unique Vec2 endpoints for corner shield collision
        self._wall_lookup = {}  # {(row, col): {"top": bool, "right": bool}}
        self._tanks = {}        # {0: TankState, 1: TankState}
        self._prev_tanks = {}   # {0: TankState, 1: TankState} — previous tick positions
        self._bullets = []      # [BulletState, ...]
        self._lives = {}        # {0: int, 1: int}
        self._tick = 0
        self._last_fire_tick = {0: -999, 1: -999}
        self._prev_potential = None  # for potential-based reward shaping
        self._tank_hit_wall = False  # set by _collide_tank_walls

        # Tie window: matches server's TIE_WINDOW_MS = 4000ms behavior
        # When first tank dies, we wait up to 4 seconds for the second to die.
        # If both die within the window → TIE (no lives lost).
        # If window expires → first-to-die player loses a life.
        self._first_death_tick = None   # tick when first tank died (None = no pending death)
        self._first_death_player = None # player_id of first tank to die (0 or 1)

    def reset(self, seed=None, options=None):
        """Reset to a new game. Generates a new maze, spawns tanks."""
        super().reset(seed=seed)  # Initializes self.np_random

        # IMPORTANT: All randomization below MUST use self.np_random
        # (not random or np.random) for reproducible seeding.
        self._maze = self._generate_maze()
        self._wall_segments = self._maze_to_segments(self._maze)
        self._wall_endpoints = self._extract_wall_endpoints(self._wall_segments)
        self._wall_lookup = self._build_wall_lookup(self._maze)
        spawns = self._get_spawn_positions()

        self._tanks = {
            0: {"x": spawns[0][0], "y": spawns[0][1], "angle": 0.0,
                "speed": 0.0, "alive": True},
            1: {"x": spawns[1][0], "y": spawns[1][1], "angle": 180.0,
                "speed": 0.0, "alive": True},
        }
        self._prev_tanks = {
            0: dict(self._tanks[0]),
            1: dict(self._tanks[1]),
        }
        self._bullets = []
        self._lives = {0: self.LIVES_PER_GAME, 1: self.LIVES_PER_GAME}
        self._tick = 0
        self._last_fire_tick = {0: -999, 1: -999}
        self._prev_potential = None
        self._tank_hit_wall = False
        self._first_death_tick = None
        self._first_death_player = None

        obs = self._get_observation(player=0)
        info = {}
        return obs, info

    def step(self, action):
        """
        Execute one decision step (3 physics ticks at 60Hz = 20Hz decisions).

        Args:
            action: int in [0, 17] — the agent's action

        Returns:
            observation, reward, terminated, truncated, info

        Kill/Tie logic (matches server TIE_WINDOW_MS = 4000ms):
            - First death: record who died, start 4-second window. Dead tank
              stays dead but game continues (surviving tank keeps playing).
            - Second death within window: TIE — no lives lost, new round.
            - Window expires without second death: first-to-die loses a life.
              Check for game end, otherwise new round.
        """
        agent_input = self._decode_action(action)
        opponent_input = self._get_opponent_action()

        reward = 0.0
        terminated = False
        truncated = False
        round_ended = False

        # Run 3 physics ticks per decision step.
        # Note: tick rewards are summed without inter-tick discounting. Strictly,
        # PBRS with γ_tick inside the loop implies tick 2 and 3 rewards should be
        # discounted by γ_tick and γ_tick² respectively. In practice the difference
        # is ~0.3% on rewards of ~0.001 magnitude — negligible. No reference
        # implementation (CleanRL, SB3) discounts within a frame-skip window.
        for _ in range(self.DECISION_INTERVAL):
            tick_reward, kill_events = self._physics_tick(agent_input, opponent_input)
            reward += tick_reward
            self._tick += 1

            # Process kills through the tie window system
            for kill_event in kill_events:
                killed = kill_event["killed"]
                killer = kill_event["killer"]

                # Immediate per-kill reward (regardless of tie outcome)
                # NOTE: use two separate `if` (not if/elif) so self-kills
                # (bullet bounces off wall and hits owner) correctly get -3.
                if killer == 0 and killed == 1:
                    reward += 3.0    # Agent killed opponent
                if killed == 0:
                    reward += -3.0   # Agent was killed (by opponent OR self-kill)

                if self._first_death_tick is None:
                    # ─── First death: start tie window ───
                    self._first_death_tick = self._tick
                    self._first_death_player = killed
                    # Tank is already set to alive=False in _physics_tick.
                    # Game continues — surviving player keeps moving/firing.
                else:
                    # ─── Second death within tie window: TIE ───
                    # No lives decremented for either player.
                    self._first_death_tick = None
                    self._first_death_player = None
                    self._new_round()
                    round_ended = True
                    break

            if round_ended:
                break

            # Check if tie window expired (first death happened > 4s ago)
            if (self._first_death_tick is not None
                    and self._tick - self._first_death_tick >= self.TIE_WINDOW_TICKS):
                # Window expired — first-to-die player loses a life
                loser = self._first_death_player
                self._lives[loser] -= 1
                self._first_death_tick = None
                self._first_death_player = None

                # Check for game end
                if self._lives[loser] <= 0:
                    terminated = True
                    if loser == 0:
                        reward += -10.0  # Agent lost the game
                    else:
                        reward += 10.0   # Agent won the game
                    break

                # Round continues with new maze
                self._new_round()
                break

            # Time limit
            if self._tick >= self.MAX_EPISODE_TICKS:
                truncated = True
                break

        obs = self._get_observation(player=0)
        info = {"lives_agent": self._lives[0], "lives_opponent": self._lives[1]}
        return obs, reward, terminated, truncated, info

    def _physics_tick(self, agent_input, opponent_input):
        """
        Single physics tick at 60Hz. Mirrors BaseTankRoom tick logic.

        Returns:
            (tick_reward, kill_events)
            kill_events is a list of {"killed": player_id, "killer": player_id}
            (usually 0 or 1 entries, rarely 2 for simultaneous kills / ties)
        """
        dt = self.DT
        reward = 0.0
        kill_events = []

        # --- 1. Update tanks ---
        inputs = {0: agent_input, 1: opponent_input}
        self._tank_hit_wall = False
        for pid in [0, 1]:
            tank = self._tanks[pid]
            if not tank["alive"]:
                continue
            inp = inputs[pid]

            # Save pre-movement position (needed for wall collision direction)
            self._prev_tanks[pid] = dict(tank)

            # Rotation
            if inp["left"]:
                tank["angle"] -= self.TANK_ROTATION_SPEED * dt
            if inp["right"]:
                tank["angle"] += self.TANK_ROTATION_SPEED * dt
            # Python's % always returns non-negative for positive divisor:
            # -10 % 360 = 350 (correct). This matches the TypeScript server's
            # ((angle % 360) + 360) % 360. Do NOT use this pattern in C/C++.
            tank["angle"] %= 360.0

            # Movement (reverse uses REVERSE_SPEED_FACTOR from constants.json)
            speed = 0.0
            if inp["up"]:
                speed = self.TANK_SPEED
            elif inp["down"]:
                speed = -self.TANK_SPEED * self.REVERSE_SPEED_FACTOR
            tank["speed"] = speed

            rad = np.radians(tank["angle"])
            tank["x"] += np.cos(rad) * speed * dt
            tank["y"] += np.sin(rad) * speed * dt

            # Clamp to canvas FIRST, then wall collision, then corner shields.
            # This order matches the server: clampTankToMaze → collideTankWithWalls
            # → collideTankWithEndpoints. Clamping first ensures the tank is always
            # in-bounds before wall checks run.
            self._clamp_tank_to_maze(tank)
            hit = self._collide_tank_walls(tank, self._prev_tanks[pid])
            if pid == 0 and hit:
                self._tank_hit_wall = True
            self._collide_tank_with_endpoints(tank)

            # Quantize to float32 to match server (Colyseus schema uses float32).
            # Without this, Python float64 accumulates tiny drift over many ticks
            # that doesn't exist in production.
            tank["x"] = np.float32(tank["x"])
            tank["y"] = np.float32(tank["y"])
            tank["angle"] = np.float32(tank["angle"])

        # --- 2. Handle firing ---
        for pid in [0, 1]:
            tank = self._tanks[pid]
            if not tank["alive"] or not inputs[pid]["fire"]:
                continue
            if self._can_fire(pid):
                bullet = self._create_bullet(pid, tank)
                self._bullets.append(bullet)
                self._last_fire_tick[pid] = self._tick

        # --- 3. Update bullets ---
        # Mirrors advanceBullet(): move → lifetime check → wall bounce → tank collision
        bullets_to_remove = []
        for i, bullet in enumerate(self._bullets):
            prev_x, prev_y = bullet["x"], bullet["y"]

            # Move
            bullet["x"] += bullet["vx"] * dt
            bullet["y"] += bullet["vy"] * dt
            bullet["age"] += dt

            # Lifetime expiry (checked BEFORE wall reflection, matching advanceBullet)
            if bullet["age"] >= self.BULLET_LIFETIME:
                bullets_to_remove.append(i)
                if bullet["owner"] == 0:
                    reward -= 0.05  # Penalty for wasted bullet
                continue

            # Wall reflection (after lifetime check)
            self._reflect_bullet(bullet, prev_x, prev_y)

            # Tank collision — checks ALL alive tanks, including the bullet owner.
            # Self-kills via wall-reflected bullets are a real game mechanic.
            # The bullet spawns outside the tank body (barrel tip), so it only
            # hits the owner if it bounces back off a wall.
            for pid in [0, 1]:
                tank = self._tanks[pid]
                if not tank["alive"]:
                    continue
                if self._check_bullet_tank_hit(bullet, tank, prev_x, prev_y):
                    tank["alive"] = False
                    bullets_to_remove.append(i)
                    kill_events.append({"killed": pid, "killer": bullet["owner"]})
                    break  # one bullet can only kill one tank

        # Remove dead bullets (reverse order to preserve indices)
        for i in sorted(set(bullets_to_remove), reverse=True):
            self._bullets.pop(i)

        # --- 4. Dense shaping rewards (agent = player 0) ---
        reward += self._compute_shaping_reward()

        return reward, kill_events

    def _new_round(self):
        """Generate new maze, respawn both tanks, clear bullets."""
        self._maze = self._generate_maze()
        self._wall_segments = self._maze_to_segments(self._maze)
        self._wall_endpoints = self._extract_wall_endpoints(self._wall_segments)
        self._wall_lookup = self._build_wall_lookup(self._maze)
        spawns = self._get_spawn_positions()
        for pid in [0, 1]:
            self._tanks[pid]["x"] = spawns[pid][0]
            self._tanks[pid]["y"] = spawns[pid][1]
            self._tanks[pid]["angle"] = 0.0 if pid == 0 else 180.0
            self._tanks[pid]["speed"] = 0.0
            self._tanks[pid]["alive"] = True
            self._prev_tanks[pid] = dict(self._tanks[pid])
        self._bullets = []
        self._last_fire_tick = {0: -999, 1: -999}
        self._prev_potential = None  # Reset to avoid spurious reward from position jump
        self._tank_hit_wall = False
        self._first_death_tick = None
        self._first_death_player = None

    # ─── Rendering (required for RecordVideo and --render mode) ───

    def render(self):
        """
        Render the current game state.

        Returns:
            - render_mode="rgb_array": numpy array of shape (H, W, 3), dtype=uint8
            - render_mode="human": displays in a pygame window (returns None)

        Required by Gymnasium's RecordVideo wrapper and --render flag.
        Uses pygame for both modes — install with: uv add pygame
        """
        if self.render_mode is None:
            return None

        import pygame

        if not hasattr(self, "_screen"):
            pygame.init()
            if self.render_mode == "human":
                self._screen = pygame.display.set_mode(
                    (self.CANVAS_W, self.CANVAS_H))
                pygame.display.set_caption("TankBattle Training")
            else:
                self._screen = pygame.Surface(
                    (self.CANVAS_W, self.CANVAS_H))
            self._clock = pygame.time.Clock()

        # Black background
        self._screen.fill((10, 14, 26))  # #0a0e1a

        # Draw walls
        for seg in self._wall_segments:
            pygame.draw.line(self._screen, (100, 116, 139),
                             (seg["x1"], seg["y1"]),
                             (seg["x2"], seg["y2"]), 2)

        # Draw tanks
        colors = {0: (74, 222, 128), 1: (248, 113, 113)}  # green, red
        for pid in [0, 1]:
            tank = self._tanks[pid]
            if not tank["alive"]:
                continue
            # Tank body (simplified as a circle for training visualization)
            cx, cy = int(tank["x"]), int(tank["y"])
            pygame.draw.circle(self._screen, colors[pid], (cx, cy),
                               self.TANK_WIDTH // 2)
            # Barrel direction line
            rad = np.radians(tank["angle"])
            bx = cx + int(np.cos(rad) * self.BARREL_LENGTH)
            by = cy + int(np.sin(rad) * self.BARREL_LENGTH)
            pygame.draw.line(self._screen, (255, 255, 255),
                             (cx, cy), (bx, by), 3)

        # Draw bullets
        for b in self._bullets:
            color = colors.get(b["owner"], (255, 255, 255))
            pygame.draw.circle(self._screen, color,
                               (int(b["x"]), int(b["y"])), 3)

        # HUD: lives
        font = pygame.font.SysFont(None, 24)
        p0_text = font.render(f"P0: {self._lives[0]}", True, colors[0])
        p1_text = font.render(f"P1: {self._lives[1]}", True, colors[1])
        self._screen.blit(p0_text, (10, 10))
        self._screen.blit(p1_text, (self.CANVAS_W - 80, 10))

        if self.render_mode == "human":
            pygame.display.flip()
            self._clock.tick(self.metadata["render_fps"])
            # Process pygame events (prevents "not responding")
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    pygame.quit()
            return None
        else:  # rgb_array
            return np.transpose(
                np.array(pygame.surfarray.pixels3d(self._screen)),
                axes=(1, 0, 2),  # pygame uses (W, H, 3), Gymnasium wants (H, W, 3)
            ).copy()

    def close(self):
        """Clean up pygame resources."""
        if hasattr(self, "_screen"):
            import pygame
            pygame.quit()
            del self._screen

    # ─── Placeholder methods (must be fully implemented) ───

    def _generate_maze(self):
        """
        Port of maze.ts generateMaze(): iterative DFS with 80% straight bias.

        This is ~100 lines of Python. Key steps:
            1. Initialize grid of cells, all walls present
            2. Iterative DFS (use a stack, not recursion) starting from random cell
            3. At each step, pick an unvisited neighbor — 80% chance to prefer
               the same direction as the last move (straight bias)
            4. Remove the wall between current cell and chosen neighbor
            5. After DFS completes, randomly remove ~20% of remaining walls
               to create loops (prevents dead-end camping)
            6. Remove walls shorter than MAZE_MIN_WALL_FRACTION of canvas width

        Must use self.np_random for all random choices (seeded reproducibility).

        Returns:
            dict with keys: "cols" (9), "rows" (6), "walls" (list of wall dicts)
            Each wall: {"row": int, "col": int, "axis": "h"|"v"}

        Reference: packages/game-engine/src/maze.ts
        """
        raise NotImplementedError

    def _maze_to_segments(self, maze):
        """
        Port of maze.ts mazeToSegments(): convert maze walls to line segments.

        Key steps:
            1. Convert each wall dict to pixel-space line segments
               - "h" wall at (row, col): horizontal line at y = row * CELL_SIZE
               - "v" wall at (row, col): vertical line at x = (col+1) * CELL_SIZE
            2. Add border walls (top, bottom, left, right edges of canvas)
            3. Merge collinear segments (reduces segment count for faster collision)
            4. Filter out segments shorter than MAZE_MIN_WALL_FRACTION * CANVAS_W

        Returns:
            list of {"x1": float, "y1": float, "x2": float, "y2": float}

        Reference: packages/game-engine/src/maze.ts
        """
        raise NotImplementedError

    def _build_wall_lookup(self, maze) -> dict:
        """
        Build a {(row, col): {"top": bool, "right": bool}} lookup table from
        the maze wall list. Used by _get_observation() for the local wall grid.

        A wall with axis='h' between (row, col) and (row-1, col) means
        cell (row, col) has a top wall. A wall with axis='v' between
        (row, col) and (row, col+1) means cell (row, col) has a right wall.
        """
        raise NotImplementedError

    def _extract_wall_endpoints(self, segments) -> list:
        """
        Port of physics.ts extractWallEndpoints(): collect unique (x, y) tuples
        from all wall segment start/end points. Used by _collide_tank_with_endpoints.
        """
        raise NotImplementedError

    def _get_spawn_positions(self):
        """Port of maze.ts getSpawnPositions(): two spawns at least 10% diagonal apart."""
        raise NotImplementedError

    def _collide_tank_walls(self, tank, prev_tank) -> bool:
        """
        Port of physics.ts collideTankWithWalls(): OBB vs wall segments.

        Args:
            tank: current tank dict (mutated in-place with corrected position)
            prev_tank: tank position before this tick's movement (for approach direction)

        Returns:
            True if any wall was hit (used for wall collision penalty)
        """
        raise NotImplementedError

    def _clamp_tank_to_maze(self, tank):
        """Port of physics.ts clampTankToMaze(): boundary enforcement."""
        raise NotImplementedError

    def _collide_tank_with_endpoints(self, tank):
        """
        Port of physics.ts collideTankWithEndpoints(): push tank away from
        wall endpoints (corners) using CORNER_SHIELD_PADDING = 4px.

        Called AFTER collideTankWithWalls(). Prevents tanks from clipping
        through the intersection points of wall segments. Iterates over
        all wall endpoints (extracted once via extractWallEndpoints) and
        pushes the tank away if its OBB + padding overlaps.

        Args:
            tank: current tank dict (mutated in-place)
        """
        raise NotImplementedError

    def _create_bullet(self, owner_id, tank):
        """
        Port of physics.ts createBullet(): spawn bullet at barrel tip.

        IMPORTANT: If the barrel tip is through a wall (tank is pressed
        against a wall and firing through it), the bullet must be reflected
        back immediately. This matches the server behavior where bullets
        can't pass through walls on spawn — they bounce back and can
        potentially self-kill the shooter.

        Steps:
            1. Calculate barrel tip position (tank center + barrel direction × spawn_dist)
            2. Check if path from tank center to barrel tip crosses any wall
            3. If yes: reflect bullet velocity at that wall (creates self-kill risk)
            4. If no: spawn normally at barrel tip with forward velocity
        """
        raise NotImplementedError

    def _reflect_bullet(self, bullet, prev_x, prev_y):
        """
        Port of physics.ts advanceBullet() wall reflection logic.

        Checks if bullet path (prev_x, prev_y) → (bullet.x, bullet.y) crosses
        any wall segment. If so, reflects velocity and carries remaining distance
        through the reflection point.

        IMPORTANT implementation details (must match TS exactly):
            1. Only handle ONE wall reflection per tick — return after the
               first crossing found (TS returns on line 487 of advanceBullet).
            2. After reflecting, offset the bullet by eps = BULLET_RADIUS + 1
               (= 4px) past the wall in the reflected direction. Without this
               epsilon, the bullet re-triggers the same wall next tick.
            3. Then carry remaining travel distance in the reflected direction:
               remainDist = totalDist - hitDist, move bullet by remainDist
               along the new velocity vector.

        Args:
            bullet: bullet dict (mutated in-place)
            prev_x: bullet x before this tick's movement
            prev_y: bullet y before this tick's movement
        """
        raise NotImplementedError

    def _check_bullet_tank_hit(self, bullet, tank, prev_bullet_x, prev_bullet_y) -> bool:
        """
        Port of physics.ts checkBulletTankCollision(): circle vs OBB + sweep test.

        Three-stage check:
            1. Point test: circle (BULLET_HIT_RADIUS=8) vs OBB (body only, shrunk by
               TANK_HITBOX_SHRINK=1px per side, barrel excluded)
            2. Sweep test: if point test missed, check if bullet path
               (prev_x, prev_y) → (x, y) crossed through the OBB
            3. Wall occlusion: if hit detected, REJECT it if any wall segment
               stands between the bullet and the tank center. This prevents
               bullets from "hitting through walls" on the same tick they bounce.

        Args:
            bullet: current bullet state
            tank: target tank state
            prev_bullet_x: bullet x before this tick (for sweep test)
            prev_bullet_y: bullet y before this tick (for sweep test)

        Returns:
            True if bullet hit the tank body (barrel excluded from hitbox)
        """
        raise NotImplementedError

    def _line_segment_crosses_any_wall(self, x1, y1, x2, y2) -> bool:
        """
        Check if the line segment (x1,y1)→(x2,y2) intersects any wall segment.
        Used by _check_bullet_tank_hit for wall occlusion — prevents bullets
        from "hitting through walls" on the same tick they bounce.

        Uses standard line-segment intersection test (cross product method).
        Returns True if ANY wall segment is crossed.
        """
        for seg in self._wall_segments:
            if self._segments_intersect(
                x1, y1, x2, y2,
                seg["x1"], seg["y1"], seg["x2"], seg["y2"],
            ):
                return True
        return False

    @staticmethod
    def _segments_intersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) -> bool:
        """Check if line segment A (ax1,ay1)→(ax2,ay2) crosses segment B."""
        def cross(ox, oy, px, py, qx, qy):
            return (px - ox) * (qy - oy) - (py - oy) * (qx - ox)

        d1 = cross(bx1, by1, bx2, by2, ax1, ay1)
        d2 = cross(bx1, by1, bx2, by2, ax2, ay2)
        d3 = cross(ax1, ay1, ax2, ay2, bx1, by1)
        d4 = cross(ax1, ay1, ax2, ay2, bx2, by2)

        if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and \
           ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)):
            return True
        return False

    def _has_wall(self, row, col, side) -> bool:
        """Check if a cell has a wall on the given side ('top' or 'right')."""
        cell = self._wall_lookup.get((row, col))
        if cell is None:
            return True  # Out of bounds = wall
        return cell.get(side, False)

    def _can_fire(self, player_id) -> bool:
        """Check if player can fire (cooldown elapsed + under max bullet count).

        NOTE: The TS canFireBullet() uses millisecond timestamps. We convert
        to ticks once at init (FIRE_COOLDOWN_TICKS) to avoid per-call
        float arithmetic that could cause off-by-one errors.
        """
        ticks_since_fire = self._tick - self._last_fire_tick[player_id]
        bullet_count = sum(1 for b in self._bullets if b["owner"] == player_id)
        return (ticks_since_fire >= self.FIRE_COOLDOWN_TICKS
                and bullet_count < self.MAX_BULLETS)

    def _get_observation(self, player):
        """Encode game state as float32 vector. See Section 5."""
        raise NotImplementedError

    def _decode_action(self, action):
        """Map int action → InputState dict. See Section 6."""
        raise NotImplementedError

    def _get_opponent_action(self):
        """
        Return opponent's action for the current tick.

        Default: random actions. This is sufficient for Phase 1 training
        (0–500K steps). Override in SelfPlayEnv for Phase 2.
        """
        return self._decode_action(self.action_space.sample())

    def _compute_shaping_reward(self):
        """Dense per-tick rewards. See Section 7."""
        raise NotImplementedError
```

### Validating the Environment

After implementing the environment, validate it before any training:

```python
from gymnasium.utils.env_checker import check_env
from tank_env import TankBattleEnv

# Catches: space mismatches, incorrect return types, missing super().reset(), etc.
check_env(TankBattleEnv())
```

Also verify with random actions:

```python
env = TankBattleEnv()
obs, info = env.reset(seed=42)
for _ in range(1000):
    action = env.action_space.sample()
    obs, reward, terminated, truncated, info = env.step(action)
    assert env.observation_space.contains(obs), f"Obs out of bounds: {obs}"
    if terminated or truncated:
        obs, info = env.reset()
print("Random rollout passed.")
```

### What Needs Porting from TypeScript → Python

These functions must be reimplemented faithfully. The physics must match exactly or the trained bot will behave differently in production.

| TypeScript Source | Python Target | Complexity |
|-------------------|---------------|------------|
| `maze.ts → generateMaze()` | `_generate_maze()` | Medium — DFS with straight bias + wall removal |
| `maze.ts → mazeToSegments()` | `_maze_to_segments()` | Medium — collinear merging + min-length filter |
| (derived from maze) | `_build_wall_lookup()` | Low — build `{(row,col): {top, right}}` dict from wall list |
| `maze.ts → getSpawnPositions()` | `_get_spawn_positions()` | Low |
| `physics.ts → updateTank()` | Tank update in `_physics_tick()` | Low — already inlined above |
| `physics.ts → clampTankToMaze()` | `_clamp_tank_to_maze()` | Low — boundary enforcement |
| `physics.ts → collideTankWithWalls()` | `_collide_tank_walls(tank, prev_tank)` | High — OBB collision with friction |
| `physics.ts → collideTankWithEndpoints()` | `_collide_tank_with_endpoints(tank)` | Medium — push away from wall corners (CORNER_SHIELD_PADDING=4px) |
| `physics.ts → createBullet()` | `_create_bullet()` | Medium — spawn at barrel tip + wall reflection on spawn |
| `physics.ts → advanceBullet()` (wall bounce part) | `_reflect_bullet(bullet, prev_x, prev_y)` | Medium — Liang-Barsky + carry-through distance |
| `physics.ts → checkBulletTankCollision()` | `_check_bullet_tank_hit(bullet, tank, prev_x, prev_y)` | High — circle vs OBB + sweep test + wall occlusion |
| `physics.ts → extractWallEndpoints()` | `_extract_wall_endpoints()` | Low — unique endpoints from wall segments |

> **Tick order matters!** The server processes each tank as: `updateTank → clampTankToMaze → collideTankWithWalls → collideTankWithEndpoints`. Getting this order wrong changes collision behavior.

**Tip:** Start with simplified collision (AABB instead of OBB) and iterate. The bot will still learn useful behavior, and you can refine the physics later.

### Verifying Physics Parity (Python ↔ TypeScript)

The trained bot will behave unpredictably if the Python physics diverge from the TypeScript server. **Run this validation suite before starting any training.** Even small drift (0.1px per tick) compounds to massive divergence over a 2-minute game (7,200 ticks).

#### Step 1: TypeScript Trace Recorder

The TS side generates the maze, runs a deterministic simulation, and dumps **both the maze data and the physics trace** to a single JSON file. The Python side loads this maze directly (no seed-based generation), ensuring both sides test against the exact same geometry.

This is necessary because TypeScript uses `mulberry32` as its PRNG while Python uses NumPy's PCG64 — the same seed produces completely different mazes. By exporting the maze from TS and importing it in Python, the parity test isolates physics differences only.

```typescript
// packages/game-engine/src/parity_trace.ts
//
// Run with: pnpm exec tsx packages/game-engine/src/parity_trace.ts
// Outputs: parity_trace.json (contains maze + wall segments + spawns + tick trace)

import {
  updateTank, clampTankToMaze, collideTankWithWalls,
  collideTankWithEndpoints, extractWallEndpoints,
  createBullet, advanceBullet,
} from './physics';
import type { TankState, BulletState, InputState } from './physics';
import { generateMaze, mazeToSegments, getSpawnPositions, mulberry32 } from './maze';
import {
  CELL_SIZE, MAZE_COLS, MAZE_ROWS,
  BULLET_FIRE_COOLDOWN_MS, MAX_BULLETS_PER_TANK,
  SERVER_TICK_HZ,
} from './constants';
import * as fs from 'fs';

const CANVAS_W = MAZE_COLS * CELL_SIZE;
const CANVAS_H = MAZE_ROWS * CELL_SIZE;
const DT = 1 / SERVER_TICK_HZ;
const TOTAL_TICKS = 1000;

const MAZE_SEED = 42;

// Fixed action sequence: alternate forward, forward+right, fire
const ACTION_SEQUENCE: InputState[] = [
  { up: true,  down: false, left: false, right: false, fire: false },  // forward
  { up: true,  down: false, left: false, right: true,  fire: false },  // forward + right
  { up: false, down: false, left: false, right: false, fire: true  },  // fire
];

// Generate maze with fixed seed
const maze = generateMaze(MAZE_COLS, MAZE_ROWS, MAZE_SEED);
const walls = mazeToSegments(maze);
const endpoints = extractWallEndpoints(walls);
const spawnRng = mulberry32(MAZE_SEED);
const spawns = getSpawnPositions(maze, spawnRng);

let tank: TankState = {
  id: 'p0', x: spawns[0].x, y: spawns[0].y, angle: 0, speed: 0,
};
let bullets: BulletState[] = [];
let lastFiredAt = -Infinity;
let bulletId = 0;

interface TickRecord {
  tick: number;
  x: number;
  y: number;
  angle: number;
  bulletCount: number;
  bulletPositions: Array<{ x: number; y: number; vx: number; vy: number }>;
}

const trace: TickRecord[] = [];

for (let tick = 0; tick < TOTAL_TICKS; tick++) {
  const action = ACTION_SEQUENCE[tick % ACTION_SEQUENCE.length];
  const prevTank = { ...tank };

  // Update tank
  tank = updateTank(tank, action, DT);
  tank = clampTankToMaze(tank, CANVAS_W, CANVAS_H);
  const collision = collideTankWithWalls(tank, prevTank, walls);
  tank = collision.tank;
  tank = collideTankWithEndpoints(tank, endpoints);

  // Fire bullet
  const now = tick * (1000 / SERVER_TICK_HZ);  // ms
  if (action.fire && (now - lastFiredAt) >= BULLET_FIRE_COOLDOWN_MS
      && bullets.length < MAX_BULLETS_PER_TANK) {
    bullets.push(createBullet(`b${bulletId++}`, tank, walls));
    lastFiredAt = now;
  }

  // Update bullets
  const newBullets: BulletState[] = [];
  for (const b of bullets) {
    const updated = advanceBullet(b, DT, walls);
    if (updated) newBullets.push(updated);
  }
  bullets = newBullets;

  // Record state
  trace.push({
    tick,
    x: Math.round(tank.x * 10000) / 10000,
    y: Math.round(tank.y * 10000) / 10000,
    angle: Math.round(tank.angle * 10000) / 10000,
    bulletCount: bullets.length,
    bulletPositions: bullets.map(b => ({
      x: Math.round(b.x * 10000) / 10000,
      y: Math.round(b.y * 10000) / 10000,
      vx: Math.round(b.vx * 10000) / 10000,
      vy: Math.round(b.vy * 10000) / 10000,
    })),
  });
}

// Write maze geometry + spawns + trace in a single file.
// Python loads the maze from here instead of generating its own,
// eliminating RNG algorithm mismatch (mulberry32 vs PCG64).
const output = {
  maze,
  wallSegments: walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
  endpoints: endpoints.map(e => ({ x: e.x, y: e.y })),
  spawns: spawns.map(s => ({ x: s.x, y: s.y })),
  trace,
};

fs.writeFileSync('parity_trace.json', JSON.stringify(output, null, 2));
console.log(`Wrote maze + ${trace.length} ticks to parity_trace.json`);
console.log(`Final tank: (${tank.x.toFixed(4)}, ${tank.y.toFixed(4)}) angle=${tank.angle.toFixed(4)}`);
```

#### Step 2: Python Parity Checker

The Python side loads the maze, wall segments, and spawn positions from the TS-generated JSON — no maze generation, no RNG involved. This isolates the test to physics-only differences.

```python
# training/parity_check.py
#
# Run with: uv run python parity_check.py
# Compares Python physics against the TypeScript trace in parity_trace.json.
#
# The JSON file contains the maze geometry (generated by TS) so both sides
# use the exact same walls and spawns. This eliminates false failures from
# different RNG algorithms (TS mulberry32 vs Python PCG64).

import json
import numpy as np
from pathlib import Path
from tank_env import TankBattleEnv

TOTAL_TICKS = 1000
TRACE_PATH = Path(__file__).resolve().parents[1] / "parity_trace.json"

# Same action sequence as TypeScript
ACTION_SEQUENCE = [1, 6, 9]  # forward, forward+right, fire (action IDs)

if not TRACE_PATH.exists():
    print(f"No TypeScript trace found at {TRACE_PATH}")
    print("Run the TS trace recorder first:")
    print("  pnpm exec tsx packages/game-engine/src/parity_trace.ts")
    raise SystemExit(1)

with open(TRACE_PATH) as f:
    data = json.load(f)

ts_trace = data["trace"]
ts_walls = data["wallSegments"]
ts_endpoints = data["endpoints"]
ts_spawns = data["spawns"]
ts_maze = data["maze"]

# Create env but override maze/walls/spawns with the TS-exported data
# instead of generating new ones (which would use a different RNG).
env = TankBattleEnv()
env._maze = ts_maze
env._wall_segments = ts_walls
env._wall_endpoints = [(e["x"], e["y"]) for e in ts_endpoints]
env._wall_lookup = env._build_wall_lookup(ts_maze)

# Set spawn positions from TS data
for pid in [0, 1]:
    env._tanks[pid]["x"] = ts_spawns[pid]["x"]
    env._tanks[pid]["y"] = ts_spawns[pid]["y"]
    env._tanks[pid]["angle"] = 0.0 if pid == 0 else 180.0
    env._tanks[pid]["speed"] = 0.0
    env._tanks[pid]["alive"] = True
    env._prev_tanks[pid] = dict(env._tanks[pid])
env._bullets = []
env._tick = 0
env._last_fire_tick = {0: -999, 1: -999}

py_trace = []
for tick in range(TOTAL_TICKS):
    action = ACTION_SEQUENCE[tick % len(ACTION_SEQUENCE)]

    # Call _physics_tick directly for tick-level comparison
    # (env.step() runs DECISION_INTERVAL=3 ticks at once)
    agent_input = env._decode_action(action)
    _, kill_events = env._physics_tick(agent_input, env._decode_action(0))  # opponent idle
    env._tick += 1

    tank = env._tanks[0]
    py_trace.append({
        "tick": tick,
        "x": round(float(tank["x"]), 4),
        "y": round(float(tank["y"]), 4),
        "angle": round(float(tank["angle"]), 4),
        "bulletCount": sum(1 for b in env._bullets if b["owner"] == 0),
    })

# Compare traces
max_dx = 0.0
max_dy = 0.0
max_da = 0.0
first_divergence = None

for py, ts in zip(py_trace, ts_trace):
    dx = abs(py["x"] - ts["x"])
    dy = abs(py["y"] - ts["y"])
    da = abs(py["angle"] - ts["angle"])

    max_dx = max(max_dx, dx)
    max_dy = max(max_dy, dy)
    max_da = max(max_da, da)

    if first_divergence is None and (dx > 0.01 or dy > 0.01):
        first_divergence = py["tick"]

print(f"Compared {len(py_trace)} ticks")
print(f"Max delta — x: {max_dx:.6f}px, y: {max_dy:.6f}px, angle: {max_da:.6f}°")

if max_dx < 0.01 and max_dy < 0.01:
    print("PASS — physics match within 0.01px tolerance")
else:
    print(f"FAIL — first divergence at tick {first_divergence}")
    print("Check tank movement, wall collision, and clamping logic.")

    # Dump the diverging ticks for debugging
    for py, ts in zip(py_trace, ts_trace):
        dx = abs(py["x"] - ts["x"])
        dy = abs(py["y"] - ts["y"])
        if dx > 0.01 or dy > 0.01:
            print(f"  tick {py['tick']}: "
                  f"py=({py['x']}, {py['y']}) "
                  f"ts=({ts['x']}, {ts['y']}) "
                  f"delta=({dx:.4f}, {dy:.4f})")
            if py["tick"] > first_divergence + 10:
                print("  ... (truncated)")
                break
```

#### Step 3: Run the Comparison

```bash
# 1. Generate TypeScript trace (includes maze geometry + physics trace)
pnpm exec tsx packages/game-engine/src/parity_trace.ts

# 2. Run Python comparison (loads maze from the JSON, no RNG involved)
cd training
uv run python parity_check.py
```

**Expected output for a correct port:**
```
Compared 1000 ticks
Max delta — x: 0.000000px, y: 0.000000px, angle: 0.000000°
PASS — physics match within 0.01px tolerance
```

**If it fails:** The dump shows the first diverging ticks. Since the maze is guaranteed identical (loaded from JSON), failures are always physics bugs. Common causes:
- Angle normalization: Python `%` vs TS `((x % 360) + 360) % 360` — for positive values they're identical, but check negative angles
- Wall collision order: must process walls in the same order
- Bullet epsilon offset missing (see `_reflect_bullet` notes above)
- float32 quantization: the Python env quantizes to `np.float32` after each tick to match Colyseus schema precision

> **When to run this:** After implementing the Python environment and after any change to physics constants or collision logic. Add it to your pre-training checklist.

### AABB Simplification (Starter Implementation)

OBB (Oriented Bounding Box) collision is the most complex part of the physics port. For initial training, you can substitute AABB (Axis-Aligned Bounding Box) collision, which treats the tank as a non-rotating square:

```python
# Simplified AABB versions for initial training.
# Replace with full OBB when you're ready to match production physics exactly.

def _collide_tank_walls(self, tank, prev_tank) -> bool:
    """AABB simplified: treat tank as axis-aligned square."""
    half = self.TANK_WIDTH // 2  # 10 for default TANK_WIDTH=20
    hit = False
    for seg in self._wall_segments:
        is_h = seg["y1"] == seg["y2"]
        is_v = seg["x1"] == seg["x2"]
        if is_h:
            wall_y = seg["y1"]
            min_x = min(seg["x1"], seg["x2"])
            max_x = max(seg["x1"], seg["x2"])
            if min_x - half < tank["x"] < max_x + half:
                if abs(tank["y"] - wall_y) < half:
                    # Push tank out of wall based on approach direction
                    if prev_tank["y"] < wall_y:
                        tank["y"] = wall_y - half
                    else:
                        tank["y"] = wall_y + half
                    hit = True
        elif is_v:
            wall_x = seg["x1"]
            min_y = min(seg["y1"], seg["y2"])
            max_y = max(seg["y1"], seg["y2"])
            if min_y - half < tank["y"] < max_y + half:
                if abs(tank["x"] - wall_x) < half:
                    if prev_tank["x"] < wall_x:
                        tank["x"] = wall_x - half
                    else:
                        tank["x"] = wall_x + half
                    hit = True
    return hit

def _clamp_tank_to_maze(self, tank):
    """AABB simplified: clamp center so edges stay inside canvas."""
    half = self.TANK_WIDTH // 2
    tank["x"] = max(half, min(tank["x"], self.CANVAS_W - half))
    tank["y"] = max(half, min(tank["y"], self.CANVAS_H - half))

def _collide_tank_with_endpoints(self, tank):
    """Simplified: skip endpoint collision for AABB (only needed for OBB corners)."""
    pass

def _check_bullet_tank_hit(self, bullet, tank, prev_bullet_x, prev_bullet_y) -> bool:
    """AABB simplified: circle vs axis-aligned square + sweep test."""
    # Point test: BULLET_HIT_RADIUS circle vs AABB
    dx = abs(bullet["x"] - tank["x"])
    dy = abs(bullet["y"] - tank["y"])
    half = self.TANK_WIDTH // 2 - self.TANK_HITBOX_SHRINK
    r = self.BULLET_HIT_RADIUS
    if dx <= half + r and dy <= half + r:
        # Wall occlusion check: reject if wall between bullet and tank
        if self._line_segment_crosses_any_wall(
            bullet["x"], bullet["y"], tank["x"], tank["y"]
        ):
            return False
        return True
    # Sweep test omitted for simplicity — add if bullets pass through tanks
    return False
```

> **Limitation:** The AABB simplification ignores the barrel — the real TS collision uses asymmetric extents (barrel side has a larger radius via `barrelExtX/Y`). This means the Python bot can fire through walls that the server would block. Also, `WALL_FRICTION` is not applied in the AABB version, but this happens to be equivalent because `WALL_FRICTION = 1.0` (zero slide) in production.
>
> **When to upgrade to OBB:** If you notice the trained bot exploiting collision differences (e.g., firing through walls at close range, or hiding at diagonal angles), switch to the full OBB implementation. For most initial training, AABB is sufficient.

---

## 4. Neural Network Architecture

### Dueling Q-Network

Adapted from [johnnycode8/dqn_pytorch/dqn.py](https://github.com/johnnycode8/dqn_pytorch):

```python
import torch
from torch import nn
import torch.nn.functional as F


class DQN(nn.Module):
    """
    Dueling DQN: splits into Value and Advantage streams after shared layers.
    Q(s,a) = V(s) + A(s,a) - mean(A(s,a))

    Based on johnnycode8/dqn_pytorch, extended with a second shared layer
    for the larger state space of our tank game.
    """

    def __init__(self, state_dim: int, action_dim: int, hidden_dim: int = 256,
                 enable_dueling: bool = True):
        super().__init__()
        self.enable_dueling = enable_dueling

        # Shared feature layers (johnnycode8 uses 1 shared layer;
        # we use 2 because our state space is ~88 dims vs 4-12 for CartPole/FlappyBird)
        self.fc1 = nn.Linear(state_dim, hidden_dim)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)

        if self.enable_dueling:
            # Value stream: state → scalar V(s)
            self.fc_value = nn.Linear(hidden_dim, 128)
            self.value = nn.Linear(128, 1)

            # Advantage stream: state → A(s,a) per action
            self.fc_advantages = nn.Linear(hidden_dim, 128)
            self.advantages = nn.Linear(128, action_dim)
        else:
            self.output = nn.Linear(hidden_dim, action_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))

        if self.enable_dueling:
            v = F.relu(self.fc_value(x))
            V = self.value(v)                                    # (batch, 1)

            a = F.relu(self.fc_advantages(x))
            A = self.advantages(a)                               # (batch, action_dim)

            Q = V + A - torch.mean(A, dim=1, keepdim=True)      # (batch, action_dim)
        else:
            Q = self.output(x)

        return Q
```

### Network Diagram

```
Input (88 float32 values)
  │
  ▼
Linear(88, 256) + ReLU      ← shared layer 1
  │
  ▼
Linear(256, 256) + ReLU     ← shared layer 2
  │
  ├────────────────────────┐
  │                        │
  ▼                        ▼
┌──────────────┐    ┌──────────────┐
│ Value Stream  │    │ Advantage    │
│              │    │ Stream       │
│ Linear(256,  │    │              │
│   128) + ReLU│    │ Linear(256,  │
│              │    │   128) + ReLU│
│ Linear(128,  │    │              │
│   1)         │    │ Linear(128,  │
│              │    │   18)        │
│ → V(s)       │    │ → A(s, a)    │
└──────┬───────┘    └──────┬───────┘
       │                    │
       └──────────┬─────────┘
                  │
                  ▼
        Q(s,a) = V(s) + A(s,a) - mean(A)
                  │
                  ▼
        Output: 18 Q-values (one per action)
```

### Parameter Count

```
Shared layers:  88 × 256 + 256 + 256 × 256 + 256  = 88,576
Value stream:   256 × 128 + 128 + 128 × 1 + 1     = 33,025
Adv. stream:    256 × 128 + 128 + 128 × 18 + 18   = 35,218
─────────────────────────────────────────────────────
Total:          ~156.8K parameters
ONNX file size: ~650KB (uncompressed), ~200KB (gzipped)
```

---

## 5. State Encoding

The observation is a flat `float32[88]` vector. All values normalized to roughly [-1, 1].

### Encoding Breakdown

```python
def _get_observation(self, player: int) -> np.ndarray:
    """
    Encode game state from the perspective of `player` (ego-centric).
    This means the SAME trained network works for both sides.
    """
    ego = self._tanks[player]
    opp = self._tanks[1 - player]
    obs = []

    # ─── Ego tank (7 values) ───
    obs.append(ego["x"] / self.CANVAS_W)                    # [0] x position, normalized [0, 1]
    obs.append(ego["y"] / self.CANVAS_H)                    # [1] y position
    obs.append(np.cos(np.radians(ego["angle"])))             # [2] facing direction (cos)
    obs.append(np.sin(np.radians(ego["angle"])))             # [3] facing direction (sin)
    obs.append(ego["speed"] / self.TANK_SPEED)               # [4] speed, normalized [-0.85, 1.0]
    obs.append(1.0 if ego["alive"] else 0.0)                 # [5] alive flag
    obs.append(self._can_fire(player) * 1.0)                 # [6] can fire right now?

    # ─── Opponent tank (7 values) — RELATIVE to ego ───
    obs.append((opp["x"] - ego["x"]) / self.CANVAS_W)         # [7]  relative x (dx)
    obs.append((opp["y"] - ego["y"]) / self.CANVAS_H)         # [8]  relative y (dy)
    rel_angle = opp["angle"] - ego["angle"]                    # relative facing angle
    obs.append(np.cos(np.radians(rel_angle)))                  # [9]  relative facing (cos)
    obs.append(np.sin(np.radians(rel_angle)))                  # [10] relative facing (sin)
    obs.append(opp["speed"] / self.TANK_SPEED)                # [11] speed
    obs.append(1.0 if opp["alive"] else 0.0)                  # [12] alive flag
    # Angle from ego's facing direction to the opponent (relative bearing).
    # This is the key aiming signal — the network doesn't have to learn
    # atan2(dy, dx) - ego_angle implicitly from raw positions.
    bearing_rad = np.arctan2(
        opp["y"] - ego["y"], opp["x"] - ego["x"]
    ) - np.radians(ego["angle"])
    obs.append(np.cos(bearing_rad))                            # [13] bearing to opponent (cos)
    obs.append(np.sin(bearing_rad))                            # [14] bearing to opponent (sin)

    # ─── Lives (2 values) ───
    obs.append(self._lives[player] / self.LIVES_PER_GAME)    # [15] ego lives [0, 1]
    obs.append(self._lives[1 - player] / self.LIVES_PER_GAME)# [16] opp lives [0, 1]

    # ─── Bullets (10 slots × 5 values = 50 values) ───
    # Sorted by distance to ego tank (closest first)
    bullet_data = []
    for b in self._bullets:
        dist = np.hypot(b["x"] - ego["x"], b["y"] - ego["y"])
        bullet_data.append((dist, b))
    bullet_data.sort(key=lambda x: x[0])

    for i in range(10):
        if i < len(bullet_data):
            _, b = bullet_data[i]
            obs.append((b["x"] - ego["x"]) / self.CANVAS_W)  # relative x (dx)
            obs.append((b["y"] - ego["y"]) / self.CANVAS_H)  # relative y (dy)
            obs.append(b["vx"] / self.BULLET_SPEED)          # velocity x [-1, 1]
            obs.append(b["vy"] / self.BULLET_SPEED)          # velocity y [-1, 1]
            obs.append(1.0 if b["owner"] == player else -1.0)# mine (+1) or opponent's (-1)
        else:
            obs.extend([0.0, 0.0, 0.0, 0.0, 0.0])          # empty slot
    # indices [17..66]
    # Note: empty slots use 0.0 for ownership, while active bullets use +1/-1.
    # This is unambiguous because an active bullet can never have dx=dy=vx=vy=0
    # simultaneously — the network learns to ignore slots where all five values are zero.

    # ─── Local wall grid (3×3 neighborhood × 2 walls = 18 values) ───
    ego_col = int(ego["x"] // self.CELL_SIZE)
    ego_row = int(ego["y"] // self.CELL_SIZE)
    for dr in [-1, 0, 1]:
        for dc in [-1, 0, 1]:
            r, c = ego_row + dr, ego_col + dc
            if 0 <= r < self.MAZE_ROWS and 0 <= c < self.MAZE_COLS:
                obs.append(1.0 if self._has_wall(r, c, "top") else 0.0)
                obs.append(1.0 if self._has_wall(r, c, "right") else 0.0)
            else:
                obs.extend([1.0, 1.0])  # border = walls exist
    # indices [67..84]
    # Note on _has_wall: the lookup only contains internal maze walls.
    # Border edges (row=0 top, col=MAZE_COLS-1 right, etc.) are implicit
    # from boundary clamping and are NOT in _wall_lookup. Make sure
    # _has_wall returns True for these edges, e.g.:
    #   if side == "top" and r == 0: return True
    #   if side == "right" and c == self.MAZE_COLS - 1: return True

    # ─── Metadata (3 values) ───
    obs.append(self._tick / self.MAX_EPISODE_TICKS)          # [85] time elapsed [0, 1]
    ego_bullets = sum(1 for b in self._bullets if b["owner"] == player)
    obs.append(ego_bullets / self.MAX_BULLETS)               # [86] bullet count [0, 1]
    opp_bullets = sum(1 for b in self._bullets if b["owner"] == (1 - player))
    obs.append(opp_bullets / self.MAX_BULLETS)               # [87] opp bullet count [0, 1]

    result = np.array(obs, dtype=np.float32)
    # Clamp to observation space bounds. Float edge cases (e.g., bullet
    # at canvas edge while ego is at opposite edge) can produce values
    # slightly outside [-1, 1]. Clamping is safer than a hard assert.
    np.clip(result, -1.0, 1.0, out=result)
    assert self.observation_space.contains(result), \
        f"Observation out of bounds: min={result.min():.3f}, max={result.max():.3f}"
    return result
```

### Why This Encoding?

| Design Choice | Rationale |
|--------------|-----------|
| **Ego-centric** (player-relative) | Same network works for both sides. No need to train separate models. |
| **Relative positions** for opponent & bullets | Ego keeps absolute pos (for wall/boundary awareness). Opponent and bullets use `(dx, dy)` relative to ego — network learns spatial relationships independent of map position. Generalizes better than absolute coordinates. |
| **Relative opponent angle** | Opponent facing encoded relative to ego's heading — same spatial relationship regardless of ego orientation. |
| **Bearing to opponent** | `cos(bearing)` + `sin(bearing)` where bearing = angle from ego's facing direction to opponent. Both components are needed — sin alone is ambiguous (sin(30°) = sin(150°)). Key aiming signal — eliminates need for the network to learn `atan2(dy,dx) - ego_angle` from raw positions. |
| **cos/sin for angle** | Avoids the 359° → 0° discontinuity. Network sees a smooth circular signal. |
| **Bullets sorted by distance** | Most threatening bullets are always in the first slots. Network doesn't have to learn to search. |
| **Local wall grid (3×3)** | Full maze (9×6 = 108 values) is wasteful — most walls are irrelevant. The local neighborhood captures what matters for immediate navigation. |
| **Normalized to [-1, 1]** | Prevents features with large magnitudes from dominating gradients. Standard practice. |
| **Fixed-size (88)** | Variable-length inputs require RNNs or attention. Fixed-size works with a simple MLP and is much faster to train. |

> **Future improvement:** The 3×3 wall grid only covers ~360px of the 1080px map. If the agent struggles with maze navigation, consider: (a) expanding to 5×5, (b) adding distance-to-nearest-wall in each cardinal direction, or (c) adding A* pathfinding distance to opponent as an extra observation feature.

---

## 6. Action Space

### Why Not 5 Booleans?

The game input is 5 booleans: `{ up, down, left, right, fire }`. That's 2^5 = 32 combinations, but many are redundant (up+down cancels out). Instead, we define **18 meaningful discrete actions**:

### Action Table

```
ID  Movement         Fire?   Description
──  ───────────────  ─────   ───────────────────────
0   none             no      Stand still
1   forward          no      Move forward
2   backward         no      Move backward
3   rotate left      no      Turn counter-clockwise
4   rotate right     no      Turn clockwise
5   forward + left   no      Move forward while turning left
6   forward + right  no      Move forward while turning right
7   backward + left  no      Move backward while turning left
8   backward + right no      Move backward while turning right
9   none             YES     Stand still + fire
10  forward          YES     Move forward + fire
11  backward         YES     Move backward + fire
12  rotate left      YES     Turn left + fire
13  rotate right     YES     Turn right + fire
14  forward + left   YES     Move forward + turn left + fire
15  forward + right  YES     Move forward + turn right + fire
16  backward + left  YES     Move backward + turn left + fire
17  backward + right YES     Move backward + turn right + fire
```

### Decoder

```python
# Action → InputState mapping
ACTION_TABLE = [
    # (up, down, left, right, fire)
    (False, False, False, False, False),  # 0:  idle
    (True,  False, False, False, False),  # 1:  forward
    (False, True,  False, False, False),  # 2:  backward
    (False, False, True,  False, False),  # 3:  rotate left
    (False, False, False, True,  False),  # 4:  rotate right
    (True,  False, True,  False, False),  # 5:  forward + left
    (True,  False, False, True,  False),  # 6:  forward + right
    (False, True,  True,  False, False),  # 7:  backward + left
    (False, True,  False, True,  False),  # 8:  backward + right
    (False, False, False, False, True),   # 9:  fire
    (True,  False, False, False, True),   # 10: forward + fire
    (False, True,  False, False, True),   # 11: backward + fire
    (False, False, True,  False, True),   # 12: left + fire
    (False, False, False, True,  True),   # 13: right + fire
    (True,  False, True,  False, True),   # 14: forward + left + fire
    (True,  False, False, True,  True),   # 15: forward + right + fire
    (False, True,  True,  False, True),   # 16: backward + left + fire
    (False, True,  False, True,  True),   # 17: backward + right + fire
]

def _decode_action(self, action: int) -> dict:
    up, down, left, right, fire = ACTION_TABLE[action]
    return {"up": up, "down": down, "left": left, "right": right, "fire": fire}
```

---

## 7. Reward Function

### Terminal Rewards (Sparse — Per Event)

These define the objective. They are large, unambiguous, and symmetric.

```python
REWARD_WIN           = +10.0     # Win the game (opponent loses all lives)
REWARD_LOSS          = -10.0     # Lose the game
REWARD_KILL          = +3.0      # Kill opponent (take one of their lives)
REWARD_DEATH         = -3.0      # Get killed (lose one of your lives)
```

### Dense Shaping Rewards (Per Tick — Accelerate Learning)

These guide early learning. They are 2-3 orders of magnitude smaller than terminal rewards so they cannot distort the final policy.

```python
def _compute_shaping_reward(self) -> float:
    """Called every physics tick (60Hz). Returns small shaping reward."""
    ego = self._tanks[0]
    opp = self._tanks[1]
    reward = 0.0

    # ─── Time penalty: prevents stalling ───
    # -0.001/tick × 7200 ticks (2 min) = -7.2 max, vs +10 for winning
    # Only penalise while alive — agent can't act during respawn/tie-window
    if ego["alive"]:
        reward -= 0.001

    # ─── Distance-based approach reward (PBRS) ───
    # Potential-Based Reward Shaping (Ng, Harada, Russell 1999):
    #   F(s, s') = γ × Φ(s') - Φ(s)
    # where Φ(s) = -distance / max_distance (potential function).
    # This exact form is proven to preserve the optimal policy —
    # the agent cannot exploit the shaping reward to change its strategy.
    # You MAY scale Φ(s) by a constant if you want (equivalently, scale F),
    # and the policy-invariance guarantee still holds. Scaling only changes
    # learning dynamics (signal magnitude), not the optimal policy.
    if ego["alive"] and opp["alive"]:
        dist = np.hypot(ego["x"] - opp["x"], ego["y"] - opp["y"])
        max_dist = np.hypot(self.CANVAS_W, self.CANVAS_H)  # diagonal ≈ 1298px
        current_potential = -dist / max_dist

        if self._prev_potential is not None:
            reward += self.discount_factor_tick * current_potential - self._prev_potential
        self._prev_potential = current_potential

    # ─── Wall collision penalty ───
    # Discourages getting stuck on walls (set by _collide_tank_walls)
    if self._tank_hit_wall:
        reward -= 0.002

    return reward
```

### Why These Specific Values?

| Reward | Value | Over Full Game | Rationale |
|--------|-------|---------------|-----------|
| Win | +10.0 | +10.0 | Dominates all other signals. The agent's primary objective. |
| Kill | +3.0 | +15.0 max (5 kills) | Strong per-round signal. Not so large that the agent ignores survival. |
| Death | -3.0 | -15.0 max (5 deaths) | Symmetric with kill. Prevents suicidal aggression. |
| Time penalty | -0.001/tick | -7.2 (2 min game) | Large enough to prevent camping, small enough that a patient winning strategy still nets positive. |
| Approach (PBRS) | ±~0.002/tick | ±~1.0 total | Gently encourages engagement. Exact PBRS form — proven not to change optimal policy. |
| Wasted bullet | -0.05/bullet | Variable | Penalizes bullets that expire without hitting. Encourages intentional aiming. |
| Wall collision | -0.002/tick | Variable | Teaches the agent that walls are obstacles, not features. |

> **Why no dodge reward?** A dodge reward (+X for bullets passing nearby without hitting) was considered but creates **perverse incentives** — the agent may learn to move *toward* bullets to collect dodge rewards. The death penalty (-3.0) is sufficient to learn evasion implicitly.

### Potential-Based Reward Shaping (PBRS)

The approach/distance reward uses **potential-based shaping** from Ng, Harada & Russell (1999):

```
F(s, s') = γ × Φ(s') - Φ(s)

Where:
  F(s, s') = the shaping reward added at each transition
  Φ(s)    = potential function (your "hint" about how good a state is)
  γ        = discount factor (same one from the Bellman equation)
  s        = current state
  s'       = next state
```

Our potential function: `Φ(s) = -distance / max_distance` (closer to opponent = higher potential).

The key requirement for the policy-invariance guarantee is that the shaping reward is of the potential-based form `F(s,s') = γΦ(s') - Φ(s)` for some potential function `Φ`. Scaling `Φ` (and therefore `F`) by a constant still preserves the guarantee; it only changes the *magnitude* of the learning signal.

**Note on multi-tick steps:** If your agent makes decisions every `DECISION_INTERVAL` physics ticks, you have two common options:
1) Apply PBRS at the decision boundary only (compute `Φ` once per `env.step()`), using the same `γ` you use for TD targets.
2) Apply PBRS each physics tick: use `γ_tick = γ_step^(1/DECISION_INTERVAL)` inside the physics loop (as shown in the code above) so the shaping remains consistent with the decision-step discounting.

**Source:** Ng, Harada, Russell — *"Policy invariance under reward transformations"* (1999), ICML.

### Training Progression

Start with **terminal rewards only** (win/loss/kill/death). Train until the agent moves and shoots. Then add dense rewards **one at a time**, verifying each improves play quality. If a dense reward causes degenerate behavior, remove it immediately.

---

## 8. Replay Buffer

### Uniform Replay Buffer

Following [johnnycode8/dqn_pytorch](https://github.com/johnnycode8/dqn_pytorch), we use a simple uniform replay buffer. This is sufficient for our game's complexity — PER adds implementation complexity and is not necessary for a first iteration.

```python
from collections import deque
import random


class ReplayMemory:
    """
    Simple uniform experience replay buffer using a deque.
    From johnnycode8/dqn_pytorch/experience_replay.py.

    Stores transitions as (state, action, new_state, reward, done) tuples.
    Where done = terminated OR truncated (Gymnasium API).
    Deque automatically evicts oldest transitions when full (FIFO).
    """

    def __init__(self, maxlen: int, seed: int = None):
        self.memory = deque([], maxlen=maxlen)
        # Use a LOCAL Random instance — never seed the global random state,
        # which would interfere with epsilon-greedy and other random calls.
        self._rng = random.Random(seed)

    def append(self, transition: tuple):
        self.memory.append(transition)

    def sample(self, sample_size: int) -> list:
        return self._rng.sample(self.memory, sample_size)

    def __len__(self) -> int:
        return len(self.memory)
```

### Buffer Configuration

```python
# Capacity: 100,000 transitions
# At 20Hz decisions × ~60s per round × ~5 rounds per game = ~6000 decisions per episode
# Buffer holds ~17 full games of experience

buffer_size = 100_000
mini_batch_size = 64
learning_starts = 10_000   # Don't train until buffer has 10K+ transitions
                           # (Mnih 2015: 50K, CleanRL: 10K)
```

**Why `learning_starts`?** The first few hundred transitions are highly correlated (all from the same episode, similar states). Training on these produces garbage gradients. Waiting for 10K diverse transitions ensures the first mini-batches are representative of the state space.

### Why NOT Prioritized Experience Replay?

PER (Schaul et al. 2015) is a valuable optimization, but:

1. **Uniform replay works well enough** for games of this complexity — johnnycode8 trained Flappy Bird to 100+ pipes with uniform replay
2. **PER adds ~100 lines of code** (Sum Tree data structure, importance sampling weights, beta annealing)
3. **Start simple, iterate** — if training plateaus, PER is an easy upgrade
4. **SB3 doesn't support it anyway**, so you'd be implementing it from scratch regardless

If you later want PER, the key changes are:
- Replace `deque` with a Sum Tree (O(log N) sampling)
- Store TD error as priority: `priority = |TD_error| + ε`
- Sample proportional to `priority^α` (α = 0.6)
- Weight losses by importance sampling: `w = (1 / (N × P(i)))^β`
- Anneal β from 0.4 → 1.0 over training

---

## 9. Training Loop

### Step 0: Validate Your DQN on CartPole First

**This is non-negotiable.** Before touching TankBattleEnv, verify the DQN implementation works on a known-good environment. If CartPole doesn't converge, TankBattle won't either — and you'll waste hours debugging physics when the real bug is in your training loop.

```python
# Validation order:
# 1. CartPole-v1 (4-dim state, 2 actions) — should solve in <500 episodes
# 2. LunarLander-v3 (8-dim state, 4 actions) — should solve in <1000 episodes
# 3. TankBattleEnv (88-dim state, 18 actions) — the real thing

# To validate, just swap the env in Agent.run():
env = gym.make("CartPole-v1")  # Step 1: validate DQN works
# env = gym.make("LunarLander-v3")  # Step 2: validate with larger state
# env = TankBattleEnv()  # Step 3: the real environment
```

**Source:** Schulman — *"Nuts and Bolts of Deep RL"*: "Construct a problem you KNOW it should work on." Irpan — *"Deep RL Doesn't Work Yet"*: "Even simple tasks like Pendulum have a ~30% failure rate."

### The Complete Training Agent

Adapted from [johnnycode8/dqn_pytorch/agent.py](https://github.com/johnnycode8/dqn_pytorch), with research-backed corrections:

- **Train every 4 steps** (Mnih 2015, CleanRL Atari) — not once per episode
- **Linear epsilon decay per step** (Mnih 2015, CleanRL, SB3) — not exponential per episode
- **Huber loss** (SmoothL1Loss) — more robust to noisy TD targets than MSE
- **Replay buffer warmup** (10K steps) — no training on correlated early data
- **TensorBoard logging** for training diagnostics
- **Video recording** via Gymnasium's `RecordVideo` wrapper
- **Resumable training state** — save/restore full training progress across sessions
- **Opponent pool checkpointing** — save model snapshots for self-play

```python
import gymnasium as gym
from gymnasium.wrappers import RecordVideo
import numpy as np
import random
import torch
from torch import nn
import itertools
import os
from torch.utils.tensorboard import SummaryWriter

from tank_env import TankBattleEnv
from dqn import DQN
from experience_replay import ReplayMemory

# ─── Version-aware directory structure ───
# Load ENV_VERSION from shared constants to organize models by physics version.
import json
from pathlib import Path

_CONSTANTS_PATH = (Path(__file__).resolve().parents[1]
                   / "packages" / "game-engine" / "src" / "constants.json")
with open(_CONSTANTS_PATH) as _f:
    _constants = json.load(_f)
ENV_VERSION = _constants["ENV_VERSION"]

RUNS_DIR = os.path.join("runs", f"v{ENV_VERSION}")
CHECKPOINT_DIR = os.path.join(RUNS_DIR, "checkpoints")
VIDEO_DIR = os.path.join(RUNS_DIR, "videos")
os.makedirs(RUNS_DIR, exist_ok=True)
os.makedirs(CHECKPOINT_DIR, exist_ok=True)
os.makedirs(VIDEO_DIR, exist_ok=True)

# Snapshot constants at training start (proves what physics this model was trained on)
_snapshot_path = os.path.join(RUNS_DIR, "constants_snapshot.json")
if not os.path.exists(_snapshot_path):
    import shutil
    shutil.copy(_CONSTANTS_PATH, _snapshot_path)

device = "cuda" if torch.cuda.is_available() else "cpu"


def linear_schedule(start_e: float, end_e: float, duration: int, t: int) -> float:
    """Linear epsilon schedule (matches CleanRL pattern)."""
    slope = (end_e - start_e) / duration
    return max(slope * t + start_e, end_e)


class Agent:
    """
    Double DQN + Dueling DQN agent for the tank battle game.
    Structure follows johnnycode8/dqn_pytorch/agent.py, with training
    frequency and epsilon schedule aligned to Mnih 2015 / CleanRL.
    """

    def __init__(self):
        # ─── Hyperparameters (see Section 12 for tuning guidance) ───
        self.learning_rate       = 1e-4
        self.discount_factor     = 0.99
        self.replay_memory_size  = 100_000
        self.mini_batch_size     = 64
        self.epsilon_start       = 1.0
        self.epsilon_end         = 0.05
        self.exploration_fraction = 0.5     # fraction of total steps over which epsilon decays
        self.total_timesteps     = 1_000_000  # total training steps (adjust based on convergence)
        self.learning_starts     = 10_000   # fill buffer before first gradient step
        self.train_frequency     = 4        # gradient step every N env steps (Mnih 2015, CleanRL Atari)
        self.network_sync_rate   = 1_000    # hard-copy target net every N steps
        self.checkpoint_interval = 100_000  # save to opponent pool every N steps
        self.video_interval      = 50       # record gameplay every N episodes
                                             # Future: lower to 10-20 during early debugging for more frequent visual feedback
        self.hidden_dim          = 256
        self.enable_double_dqn   = True
        self.enable_dueling_dqn  = True

        self.loss_fn = nn.SmoothL1Loss()    # Huber loss — robust to noisy TD targets
        self.optimizer = None

        self.MODEL_FILE = os.path.join(RUNS_DIR, f"ddqn_tankbet-v{ENV_VERSION}_latest.pt")
        self.BEST_MODEL_FILE = os.path.join(RUNS_DIR, f"ddqn_tankbet-v{ENV_VERSION}_best.pt")
        self.STATE_FILE = os.path.join(RUNS_DIR, "training_state.pt")

    def run(self, is_training: bool = True, render: bool = False,
            resume: bool = False):
        # Reproducibility (optional but recommended when debugging).
        # Seed *once* and rely on each RNG's internal sequence progression.
        seed = 42
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        # If you need strict CUDA determinism, also set:
        # torch.backends.cudnn.deterministic = True
        # torch.backends.cudnn.benchmark = False

        # ─── Environment setup ───
        if render:
            env = TankBattleEnv(render_mode="human",
                                discount_factor=self.discount_factor)
        elif is_training:
            # Record gameplay videos periodically for visual inspection.
            # render_mode="rgb_array" tells the env to produce pixel frames.
            # RecordVideo only calls render() on recorded episodes, so non-recorded
            # episodes have minimal overhead.
            env = TankBattleEnv(render_mode="rgb_array",
                                discount_factor=self.discount_factor)
            # NOTE: Video recording is optional and is a common source of setup pain.
            # RecordVideo typically needs an encoder available (often ffmpeg).
            # If you hit video/codec errors, comment out RecordVideo and keep training.
            # If you're on headless Linux and pygame/rendering fails, also try:
            #   export SDL_VIDEODRIVER=dummy
            env = RecordVideo(
                env,
                video_folder=VIDEO_DIR,
                episode_trigger=lambda ep: ep % self.video_interval == 0,
                name_prefix="training",
            )
        else:
            env = TankBattleEnv(discount_factor=self.discount_factor)

        num_states = env.observation_space.shape[0]   # 88
        num_actions = env.action_space.n              # 18

        # ─── Create networks ───
        policy_dqn = DQN(num_states, num_actions, self.hidden_dim,
                         self.enable_dueling_dqn).to(device)

        if is_training:
            memory = ReplayMemory(self.replay_memory_size)
            writer = SummaryWriter(os.path.join(RUNS_DIR, "tb_logs"))

            target_dqn = DQN(num_states, num_actions, self.hidden_dim,
                             self.enable_dueling_dqn).to(device)
            target_dqn.load_state_dict(policy_dqn.state_dict())

            self.optimizer = torch.optim.Adam(policy_dqn.parameters(),
                                              lr=self.learning_rate)
            global_step = 0
            start_episode = 0
            best_reward = -float("inf")
            rewards_history = []

            # ─── Resume from checkpoint if requested ───
            if resume and os.path.exists(self.STATE_FILE):
                # weights_only=False because checkpoint contains optimizer state
                # (Adam momentum buffers use non-tensor types internally).
                # This is safe — we only load our own training checkpoints.
                checkpoint = torch.load(self.STATE_FILE, map_location=device, weights_only=False)
                policy_dqn.load_state_dict(checkpoint["model_state"])
                target_dqn.load_state_dict(checkpoint["target_state"])
                self.optimizer.load_state_dict(checkpoint["optimizer_state"])
                global_step = checkpoint["global_step"]
                start_episode = checkpoint["episode"]
                best_reward = checkpoint["best_reward"]
                rewards_history = checkpoint["rewards_history"]
                print(f"Resumed from step {global_step}, episode {start_episode}")
        else:
            if not os.path.exists(self.MODEL_FILE):
                print(f"No trained model found at {self.MODEL_FILE}. Train first.")
                env.close()
                return
            # Model-only file: pure state dict, safe with weights_only=True (default).
            eval_state = torch.load(self.MODEL_FILE, map_location=device)
            policy_dqn.load_state_dict(eval_state)
            policy_dqn.eval()

        # ─── Main training loop ───
        # Wrapped in try/finally so Ctrl+C saves progress and closes TensorBoard.
        episode = start_episode if is_training else 0  # init before loop (avoids NameError in except)
        first_episode = episode
        try:
            for episode in itertools.count(start=first_episode):
                # Seed the environment ONCE (first reset). Subsequent resets should
                # not pass a seed so the env's RNG progresses (new mazes each episode)
                # while still being reproducible across runs.
                if episode == first_episode:
                    env.action_space.seed(seed)
                    env.observation_space.seed(seed)
                    state, _ = env.reset(seed=seed)
                else:
                    state, _ = env.reset()
                state = torch.tensor(state, dtype=torch.float, device=device)
                terminated = False
                truncated = False
                episode_reward = 0.0
                episode_length = 0

                # ─── Episode loop ───
                while not terminated and not truncated:
                    # Linear epsilon schedule (per step)
                    epsilon = linear_schedule(
                        self.epsilon_start, self.epsilon_end,
                        int(self.exploration_fraction * self.total_timesteps),
                        global_step,
                    ) if is_training else 0.0

                    # Epsilon-greedy action selection
                    if is_training and random.random() < epsilon:
                        action = env.action_space.sample()
                        action = torch.tensor(action, dtype=torch.int64, device=device)
                    else:
                        with torch.no_grad():
                            action = policy_dqn(state.unsqueeze(dim=0)).squeeze().argmax()

                    new_state, reward, terminated, truncated, info = env.step(action.item())
                    episode_reward += reward
                    episode_length += 1

                    new_state = torch.tensor(new_state, dtype=torch.float, device=device)
                    reward = torch.tensor(reward, dtype=torch.float, device=device)

                    if is_training:
                        # Only zero the bootstrap on TRUE terminal states (terminated),
                        # NOT on time-limit truncations. When truncated, the game could
                        # have continued — future value exists, we just stopped observing.
                        # Using `terminated or truncated` here is a well-known bug that
                        # causes the agent to incorrectly learn that late-game states
                        # have zero future value.
                        # Source: CleanRL dqn.py, Gymnasium time-limits tutorial.
                        #
                        # Store replay on CPU (especially important if device="cuda"),
                        # otherwise your replay buffer silently becomes GPU memory.
                        memory.append((state.detach().cpu(),
                                       action.detach().cpu(),
                                       new_state.detach().cpu(),
                                       reward.detach().cpu(),
                                       terminated))
                        global_step += 1

                        # ─── Train every 4 steps (after warmup) ───
                        if (global_step > self.learning_starts
                                and global_step % self.train_frequency == 0):
                            mini_batch = memory.sample(self.mini_batch_size)
                            loss = self.optimize(mini_batch, policy_dqn, target_dqn)

                            # Log training metrics
                            if global_step % 100 == 0:
                                writer.add_scalar("losses/td_loss", loss, global_step)
                                writer.add_scalar("charts/epsilon", epsilon, global_step)

                        # ─── Sync target network (hard copy) ───
                        if (global_step > self.learning_starts
                                and global_step % self.network_sync_rate == 0):
                            target_dqn.load_state_dict(policy_dqn.state_dict())

                        # ─── Save to opponent pool (for self-play) ───
                        if global_step % self.checkpoint_interval == 0:
                            pool_path = os.path.join(
                                CHECKPOINT_DIR, f"step_{global_step}.pt")
                            torch.save(policy_dqn.state_dict(), pool_path)

                    state = new_state

                    # Stop if we've hit the total timestep budget
                    if is_training and global_step >= self.total_timesteps:
                        truncated = True

                # ─── End of episode: log and save ───
                if is_training:
                    rewards_history.append(episode_reward)
                    writer.add_scalar("charts/episode_reward", episode_reward, global_step)
                    writer.add_scalar("charts/episode_length", episode_length, global_step)

                    # Save best model (only after warmup — early random play
                    # produces garbage models that aren't worth saving)
                    if (episode_reward > best_reward
                            and global_step > self.learning_starts):
                        best_reward = episode_reward
                        torch.save(policy_dqn.state_dict(), self.BEST_MODEL_FILE)

                    # Periodic logging
                    if episode % 100 == 0 and episode > 0:
                        avg = np.mean(rewards_history[-100:])
                        print(f"Episode {episode} | Step {global_step} | "
                              f"avg reward (100) = {avg:.2f} | ε = {epsilon:.4f}")

                    # Save full training state (resumable across sessions)
                    if episode % 50 == 0 and episode > 0:
                        torch.save({
                            "model_state": policy_dqn.state_dict(),
                            "target_state": target_dqn.state_dict(),
                            "optimizer_state": self.optimizer.state_dict(),
                            "global_step": global_step,
                            "episode": episode,
                            "best_reward": best_reward,
                            "rewards_history": rewards_history[-1000:],
                        }, self.STATE_FILE)

                    # Done?
                    if global_step >= self.total_timesteps:
                        break

        except KeyboardInterrupt:
            if is_training:
                print(f"\nInterrupted at step {global_step}, episode {episode}.")

        finally:
            if is_training:
                # Always save on exit (clean or interrupted)
                torch.save({
                    "model_state": policy_dqn.state_dict(),
                    "target_state": target_dqn.state_dict(),
                    "optimizer_state": self.optimizer.state_dict(),
                    "global_step": global_step,
                    "episode": episode,
                    "best_reward": best_reward,
                    "rewards_history": rewards_history[-1000:],
                }, self.STATE_FILE)
                torch.save(policy_dqn.state_dict(), self.MODEL_FILE)
                writer.close()
                print(f"Saved state at step {global_step}, episode {episode}.")
            env.close()

    def optimize(self, mini_batch: list, policy_dqn: DQN, target_dqn: DQN) -> float:
        """
        One gradient step on a mini-batch from the replay buffer.
        Implements Double DQN target calculation (van Hasselt et al. 2015).

        Returns:
            loss value (float) for logging.
        """
        states, actions, new_states, rewards, dones = zip(*mini_batch)

        states = torch.stack(states).to(device)
        actions = torch.stack(actions).to(device)
        new_states = torch.stack(new_states).to(device)
        rewards = torch.stack(rewards).to(device)
        dones = torch.tensor(dones, dtype=torch.float32, device=device)

        with torch.no_grad():
            if self.enable_double_dqn:
                # Double DQN: policy net SELECTS, target net EVALUATES
                best_actions = policy_dqn(new_states).argmax(dim=1)
                target_q = rewards + (1 - dones) * self.discount_factor * \
                    target_dqn(new_states) \
                    .gather(dim=1, index=best_actions.unsqueeze(dim=1)).squeeze()
            else:
                # Standard DQN: target net both selects and evaluates
                target_q = rewards + (1 - dones) * self.discount_factor * \
                    target_dqn(new_states).max(dim=1)[0]

        # Current Q-values for the actions that were actually taken
        current_q = policy_dqn(states) \
            .gather(dim=1, index=actions.unsqueeze(dim=1)).squeeze()

        loss = self.loss_fn(current_q, target_q)

        self.optimizer.zero_grad()
        loss.backward()
        self.optimizer.step()

        return loss.item()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval", action="store_true", help="Run evaluation (no training)")
    parser.add_argument("--render", action="store_true", help="Open live game window")
    parser.add_argument("--resume", action="store_true", help="Resume from last checkpoint")
    args = parser.parse_args()

    agent = Agent()
    agent.run(
        is_training=not args.eval,
        render=args.render,
        resume=args.resume,
    )
```

### Key Design Decisions

| Decision | Choice | Rationale | Source |
|----------|--------|-----------|--------|
| **Train frequency** | Every 4 steps | Standard for DQN. Ensures enough gradient updates per episode. | Mnih 2015 (CleanRL uses 10) |
| **Epsilon decay** | Linear per step | Decouples exploration from episode length. Universal standard. | Mnih 2015, CleanRL, SB3 |
| **Loss function** | Huber (SmoothL1) | Robust to noisy TD targets — caps gradient for large errors. MSE amplifies outliers. | PyTorch DQN tutorial, CleanRL |
| **Buffer warmup** | 10,000 steps | Ensures first mini-batches aren't extremely correlated. | Mnih 2015 (50K), CleanRL (10K) |
| **Target sync** | Hard copy every 1,000 steps | Standard for DQN. Polyak/soft update is for actor-critic (DDPG/SAC). | Mnih 2015, CleanRL |
| **Optimizer** | Adam at 1e-4 | Universal default for DQN. | CleanRL, SB3 |
| **Gradient clipping** | Not included (optional) | Huber loss already caps gradients for large TD errors. Add `clip_grad_norm_(params, 10)` if you see instability. | — |

### Epsilon Schedule: Linear Per Step

Following the original DQN paper (Mnih 2015) and CleanRL:

```python
# Linear decay from 1.0 → 0.05 over 50% of training (500K steps)
# exploration_fraction = 0.5, total_timesteps = 1_000_000
#
# Step 0:       ε = 1.0    (fully random)
# Step 100K:    ε = 0.81
# Step 250K:    ε = 0.525
# Step 500K:    ε = 0.05   (floor reached)
# Step 500K+:   ε = 0.05   (held constant)
```

**Why linear over exponential?** Linear decay is decoupled from episode length — every step reduces epsilon by the same amount regardless of whether episodes are short (CartPole) or long (TankBattle). Exponential per-episode decay couples exploration to episode count, which breaks down for long episodes.

### Monitoring Training (TensorBoard)

```bash
# Launch TensorBoard to watch training progress
# Use runs/ (not runs/tb_logs) — logs are under runs/v{ENV_VERSION}/tb_logs/
uv run tensorboard --logdir runs/
```

Key metrics to watch:
- **`charts/episode_reward`** — primary success metric. Should trend upward.
- **`charts/episode_length`** — decreasing length often means more efficient play.
- **`losses/td_loss`** — should decrease over time. Spikes early are normal.
- **`charts/epsilon`** — verify the decay schedule looks correct.

If episode reward plateaus while epsilon is still high, the agent isn't learning from its experiences (check reward function, network capacity). If episode reward drops after epsilon reaches its floor, the agent may have overfit to exploration noise (increase `epsilon_end` or buffer size).

### Training Timeline (Expected)

| Steps | Episodes (~) | Wall Clock | Behavior |
|-------|-------------|-----------|----------|
| 0 – 10K | ~2 | ~5 min | Buffer warmup. Random play. No training yet. |
| 10K – 100K | ~15 | ~30 min | Training starts. Learns to move. ε ≈ 0.81. |
| 100K – 250K | ~40 | ~1.5 hours | Basic pursuit. Learns to fire at opponent. ε ≈ 0.53. |
| 250K – 500K | ~80 | ~3 hours | Intentional aiming. Begins dodging. ε ≈ 0.05 (floor). |
| 500K – 1M | ~160 | ~6 hours | Refinement. Tactical play. Life-aware strategy. ε = 0.05. |

**Note:** Estimates assume ~6000 decision steps per episode at 20Hz × ~60s average. Actual times depend on Python physics simulation speed. Training runs on **CPU** — a 157K parameter model is too small for GPU overhead to pay off.

### Directory Structure & Model Versioning

All training artifacts are saved to the filesystem, organized by **environment version**. No database needed. When you change a constant in `constants.json`, bump `ENV_VERSION` — this creates a new directory and old models are preserved but never loaded against the wrong physics.

```
runs/
├── v1/                       # ENV_VERSION=1 (current)
│   ├── constants_snapshot.json   # Frozen copy of constants.json at training start
│   ├── tb_logs/                  # TensorBoard logs (persists across sessions)
│   ├── training_state.pt         # Full resumable state
│   ├── ddqn_tankbet-v1_latest.pt # Latest model weights
│   ├── ddqn_tankbet-v1_best.pt   # Best model (highest episode reward)
│   ├── checkpoints/              # Opponent pool for self-play
│   │   ├── step_100000.pt
│   │   └── step_200000.pt
│   └── videos/                   # Recorded gameplay
│       ├── training-episode-0.mp4
│       └── training-episode-50.mp4
│
├── v2/                       # After bumping ENV_VERSION (e.g., doubled bullet speed)
│   ├── constants_snapshot.json   # Different constants than v1
│   ├── tb_logs/
│   └── ...
```

**Model naming convention:** `ddqn_tankbet-v{ENV_VERSION}_{suffix}.pt`

| File | Purpose |
|------|---------|
| `ddqn_tankbet-v1_latest.pt` | Latest model from current training run |
| `ddqn_tankbet-v1_best.pt` | Best episode reward seen during training |
| `training_state.pt` | Full checkpoint (model + optimizer + step count) for resuming |
| `constants_snapshot.json` | Frozen constants — proves this model was trained on these values |

**When constants change:**
1. Edit `packages/game-engine/src/constants.json`
2. Bump `ENV_VERSION` (e.g., 1 → 2)
3. Training automatically creates `runs/v2/` and snapshots the new constants
4. Old models in `runs/v1/` are preserved but never loaded — physics changed, old policy is invalid
5. The exported ONNX model includes the version: `ddqn_tankbet-v2.onnx`

### Resuming Training Across Sessions

Training can be stopped and resumed without losing progress:

```bash
# Start fresh
uv run python agent.py

# Stop with Ctrl+C at any time. State is saved every 50 episodes.

# Resume from where you left off
uv run python agent.py --resume

# Watch the trained agent play (live window, no training)
uv run python agent.py --eval --render
```

The `training_state.pt` checkpoint saves everything needed to resume: model weights, target network weights, optimizer state (Adam momentum), global step count, episode count, best reward, and recent reward history. Epsilon is recomputed from `global_step` via `linear_schedule()`, so it's automatically correct on resume.

> **Note:** The replay buffer is **not** saved (it would be ~400MB). After resuming, the buffer starts empty and must collect `learning_starts` (10K) transitions before gradient updates resume — this takes ~2 episodes of play. This is normal and expected; the model still holds all learned weights from before the interruption.
>
> **Optimization:** To reduce the warmup gap on resume, you can either: (a) lower `learning_starts` to 1,000 when resuming (the model already has good weights — it just needs enough diverse transitions to avoid correlated gradients), or (b) save a subset of the buffer (e.g., last 50K transitions) to a separate file. Option (a) is simpler and usually sufficient.

### Practical Training Workflow

Training is a manual, iterative process. Use **Python scripts** for training (not Jupyter notebooks — notebooks are for prototyping but break on long runs due to kernel disconnects and memory leaks). Use TensorBoard + recorded videos to monitor progress.

**Step 1: Validate on CartPole** (see Step 0 above)

**Step 2: Train with sparse rewards only**

```python
# In _compute_shaping_reward(), return 0.0 (disable all shaping)
# Keep only: win (+10), loss (-10), kill (+3), death (-3)
```

```bash
uv run python agent.py
uv run tensorboard --logdir runs/  # open in browser
```

Train for ~200K steps. Check TensorBoard every 15-30 min:
- Is `charts/episode_reward` trending up?
- Is `charts/episode_length` decreasing?

Watch the recorded videos in `runs/videos/` — does the agent move? Shoot? Aim toward the opponent?

**Step 3: Add shaping rewards one at a time**

Uncomment one reward, train another ~200K steps, verify it helps:
1. Time penalty → does episode length decrease?
2. Approach reward → does the agent close distance?
3. Wall penalty → does the agent navigate more smoothly?
4. Wasted bullet penalty → does the agent aim more intentionally?

If any reward causes degenerate behavior (e.g., agent dies fast to avoid time penalty), remove it.

```bash
# Resume from the previous checkpoint after tweaking rewards
uv run python agent.py --resume
```

**Step 4: Switch to self-play** (see Section 10)

At ~500K steps, the opponent pool in `runs/checkpoints/` has 5 snapshots. Switch `TankBattleEnv` to `SelfPlayEnv` and continue training.

### Developer Shortcuts

Add these to your shell profile (`~/.zshrc` or `~/.bashrc`) for quick access:

```bash
# Set TANKBET_DIR to your repo root (adjust if cloned elsewhere)
export TANKBET_DIR="$HOME/Documents/software/tankbet"

# ─── Training commands (uv run auto-activates the venv) ───
alias tank-train="cd $TANKBET_DIR/training && uv run python agent.py"
alias tank-resume="cd $TANKBET_DIR/training && uv run python agent.py --resume"
alias tank-watch="cd $TANKBET_DIR/training && uv run python agent.py --eval --render"

# ─── Monitoring (--logdir runs/ recursively discovers all version subdirs) ───
alias tank-board="cd $TANKBET_DIR/training && uv run tensorboard --logdir runs/ &>/dev/null & open http://localhost:6006"
alias tank-videos="open $TANKBET_DIR/training/runs/"  # Browse to v{N}/videos/

# ─── Export trained model to the backend (script handles the copy) ───
alias tank-export="cd $TANKBET_DIR/training && uv run python export_onnx.py"

# ─── Full workflow: start training + open TensorBoard ───
alias tank-start="tank-board && sleep 1 && tank-train"
alias tank-start-resume="tank-board && sleep 1 && tank-resume"
```

Typical session:

```bash
# First time: start training + TensorBoard
tank-start

# Check in later: open TensorBoard + watch videos
tank-board
tank-videos

# Resume after stopping
tank-start-resume

# See the agent play live (after some training)
tank-watch

# Happy with the model? Export and deploy
tank-export
```

---

## 10. Self-Play

### Why Self-Play?

Training against a fixed opponent (random or scripted) produces a **brittle** policy that exploits specific weaknesses. Self-play forces the agent to remain robust against diverse strategies.

### Implementation: Opponent Pool

```python
import os
import torch
from dqn import DQN


class SelfPlayEnv(TankBattleEnv):
    """
    Wraps TankBattleEnv to use a pool of past agent snapshots as opponents.
    """

    def __init__(self, render_mode=None, discount_factor=0.99,
                 opponent_pool_dir: str = CHECKPOINT_DIR,
                 state_dim: int = 88, action_dim: int = 18, hidden_dim: int = 256):
        super().__init__(render_mode=render_mode, discount_factor=discount_factor)
        self.opponent_pool_dir = opponent_pool_dir
        self.state_dim = state_dim
        self.action_dim = action_dim
        self.hidden_dim = hidden_dim
        self.opponent_model = None
        # Don't call _load_random_opponent() here — self.np_random isn't
        # seeded until reset(seed=...) is called. Loading here would use
        # an unseeded RNG, breaking reproducibility. The first reset()
        # will load an opponent.

    def _load_random_opponent(self):
        """Load a random opponent from the checkpoint pool."""
        if not os.path.exists(self.opponent_pool_dir):
            self.opponent_model = None
            return

        checkpoints = sorted([
            f for f in os.listdir(self.opponent_pool_dir)
            if f.endswith(".pt")
        ])

        if len(checkpoints) == 0:
            self.opponent_model = None
            return

        # 50% chance: play against latest snapshot
        # 50% chance: play against random historical snapshot
        # Use self.np_random (seeded by env.reset(seed=...)) for reproducibility.
        if self.np_random.random() < 0.5 or len(checkpoints) == 1:
            chosen = checkpoints[-1]
        else:
            pool = checkpoints[-10:]  # Last 10 checkpoints
            chosen = self.np_random.choice(pool)

        path = os.path.join(self.opponent_pool_dir, chosen)
        model = DQN(self.state_dim, self.action_dim, self.hidden_dim,
                     enable_dueling=True)
        opp_state = torch.load(path, map_location="cpu")
        model.load_state_dict(opp_state)
        model.eval()
        self.opponent_model = model

    def reset(self, **kwargs):
        """On each new episode, potentially load a different opponent."""
        obs, info = super().reset(**kwargs)
        # self.np_random is now seeded (by super().reset(seed=...)).
        # Load opponent on first call or with 20% probability thereafter.
        if self.opponent_model is None or self.np_random.random() < 0.2:
            self._load_random_opponent()
        return obs, info

    def _get_opponent_action(self) -> dict:
        """Get opponent's action from the loaded model (or random).

        Note: the opponent currently plays greedily (argmax). If the trained
        agent appears brittle against real players, consider adding a small
        epsilon (e.g., 3% random actions) here so the training agent can't
        exploit the opponent's perfect determinism. The opponent pool already
        provides some strategy diversity, so this is a secondary lever.
        """
        if self.opponent_model is None:
            return self._decode_action(self.action_space.sample())

        opp_obs = self._get_observation(player=1)  # Ego-centric from opponent's view
        opp_state = torch.tensor(opp_obs, dtype=torch.float)
        with torch.no_grad():
            action = self.opponent_model(opp_state.unsqueeze(0)).squeeze().argmax().item()
        return self._decode_action(action)

    def close(self):
        """Free opponent model and clean up pygame resources."""
        self.opponent_model = None
        super().close()
```

### Training Phases

```
Phase 1: Random Opponent (0 – 500K steps, ~80 episodes)
────────────────────────────────────────────────────────
Opponent takes random actions. Agent learns basics: movement, aiming, firing.
Save checkpoints every 100K steps.

Phase 2: Self-Play (500K+ steps)
─────────────────────────────────
Switch to SelfPlayEnv. Agent plays against past versions of itself.
Checkpoints saved every 100K steps → opponent pool grows over time.
```

> **Note:** At ~6,000 decision steps per episode, 1M total steps ≈ 167 episodes. Phase boundaries are defined in steps, not episodes, since episode length varies.

### Preventing Strategy Cycling

**Problem:** Agent v3 beats v2, v4 beats v3, but v4 loses to v2.

**Solution:** The opponent pool (keeping the last 10 snapshots) forces the agent to beat a **diversity** of strategies. The 50/50 split between latest and historical opponents ensures it can't overfit to the most recent version.

---

## 11. Export & Server Deployment

### Step 1: Export Trained Model to ONNX

```python
import os
import torch
from dqn import DQN


def export_to_onnx(model_path: str, output_path: str,
                   state_dim: int = 88, action_dim: int = 18,
                   hidden_dim: int = 256, enable_dueling: bool = True):
    """
    Export a trained PyTorch DQN model to ONNX format for server inference.

    Note: OnnxableSB3Policy is NOT a real SB3 class — it's a pattern from docs.
    Since we use custom PyTorch, we export directly.

    IMPORTANT: enable_dueling must match the value used during training.
    If you trained with enable_dueling_dqn=False, pass enable_dueling=False here.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    model = DQN(state_dim, action_dim, hidden_dim, enable_dueling=enable_dueling)
    state_dict = torch.load(model_path, map_location="cpu")
    model.load_state_dict(state_dict)
    model.eval()
    model.cpu()  # export on CPU to avoid device-specific surprises

    dummy_input = torch.randn(1, state_dim, dtype=torch.float32)

    # If ONNX export errors on your machine, try:
    # - lowering opset_version (e.g., 17)
    # - pinning torch/onnx/onnxscript versions
    # - using the legacy exporter if available in your torch version
    torch.onnx.export(
        model,
        dummy_input,
        output_path,
        export_params=True,
        opset_version=18,
        input_names=["observation"],
        output_names=["q_values"],
        dynamic_axes={
            "observation": {0: "batch_size"},
            "q_values": {0: "batch_size"},
        },
    )
    print(f"Exported to {output_path}")
    print(f"File size: {os.path.getsize(output_path) / 1024:.1f} KB")


# Usage (reads ENV_VERSION from constants.json):
import json
from pathlib import Path

_repo_root = Path(__file__).resolve().parents[1]
_cpath = _repo_root / "packages" / "game-engine" / "src" / "constants.json"
with open(_cpath) as _f:
    _v = json.load(_f)["ENV_VERSION"]

onnx_path = f"./models/ddqn_tankbet-v{_v}.onnx"
export_to_onnx(
    model_path=f"./runs/v{_v}/ddqn_tankbet-v{_v}_best.pt",
    output_path=onnx_path,
)

# Copy to backend bot directory for deployment
import shutil
bot_dir = _repo_root / "apps" / "backend" / "src" / "bot"
dest = bot_dir / "tank_bot.onnx"
shutil.copy(onnx_path, dest)
print(f"Deployed to {dest}")
```

### Step 2: Install ONNX Runtime

```bash
# Server-side (Node.js native bindings — used by BotPlayer in TankRoom)
pnpm add onnxruntime-node --filter @tankbet/backend
```

> **Where does inference run?** The bot runs server-side as a virtual player in TankRoom. The server controls the bot's tank just like it processes real player inputs. `onnxruntime-node` uses native C++ bindings and is faster than WASM.

### Step 3: State Encoder (TypeScript)

```typescript
// apps/backend/src/bot/StateEncoder.ts

import {
  CELL_SIZE,
  MAZE_COLS,
  MAZE_ROWS,
  TANK_SPEED,
  BULLET_SPEED,
  MAX_BULLETS_PER_TANK,
  LIVES_PER_GAME,
} from "@tankbet/game-engine/constants";

const CANVAS_W = MAZE_COLS * CELL_SIZE; // 1080
const CANVAS_H = MAZE_ROWS * CELL_SIZE; // 720

interface TankState {
  x: number;
  y: number;
  angle: number;
  speed: number;
  alive: boolean;
}

interface BulletState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
}

interface WallLookup {
  hasTopWall(row: number, col: number): boolean;
  hasRightWall(row: number, col: number): boolean;
}

export interface GameSnapshot {
  ego: TankState;
  opponent: TankState;
  egoLives: number;
  opponentLives: number;
  bullets: BulletState[];
  egoPlayerId: string;
  walls: WallLookup;
  canFire: boolean;
  tick: number;
  maxTicks: number;
}

/**
 * Encodes the game state into a Float32Array(88) matching
 * the Python training environment's observation format.
 *
 * IMPORTANT: This encoding MUST match _get_observation() in the
 * Python Gymnasium environment exactly, or the trained model
 * will receive garbage inputs and behave randomly.
 */
export function encodeState(snapshot: GameSnapshot): Float32Array {
  const obs = new Float32Array(88);
  let idx = 0;

  const { ego, opponent, egoPlayerId, bullets, walls } = snapshot;

  // ─── Ego tank (7 values) ───
  obs[idx++] = ego.x / CANVAS_W;
  obs[idx++] = ego.y / CANVAS_H;
  obs[idx++] = Math.cos((ego.angle * Math.PI) / 180);
  obs[idx++] = Math.sin((ego.angle * Math.PI) / 180);
  obs[idx++] = ego.speed / TANK_SPEED;
  obs[idx++] = ego.alive ? 1.0 : 0.0;
  obs[idx++] = snapshot.canFire ? 1.0 : 0.0;

  // ─── Opponent tank (7 values) — RELATIVE to ego ───
  obs[idx++] = (opponent.x - ego.x) / CANVAS_W;
  obs[idx++] = (opponent.y - ego.y) / CANVAS_H;
  const relAngle = ((opponent.angle - ego.angle) * Math.PI) / 180;
  obs[idx++] = Math.cos(relAngle);                             // relative facing (cos)
  obs[idx++] = Math.sin(relAngle);                             // relative facing (sin)
  obs[idx++] = opponent.speed / TANK_SPEED;
  obs[idx++] = opponent.alive ? 1.0 : 0.0;
  // Bearing from ego's facing direction to opponent (aiming signal)
  const bearing =
    Math.atan2(opponent.y - ego.y, opponent.x - ego.x) -
    (ego.angle * Math.PI) / 180;
  obs[idx++] = Math.cos(bearing);
  obs[idx++] = Math.sin(bearing);

  // ─── Lives (2 values) ───
  obs[idx++] = snapshot.egoLives / LIVES_PER_GAME;
  obs[idx++] = snapshot.opponentLives / LIVES_PER_GAME;

  // ─── Bullets: 10 slots × 5 values = 50 values ───
  const sortedBullets = [...bullets]
    .map((b) => ({
      ...b,
      dist: Math.hypot(b.x - ego.x, b.y - ego.y),
    }))
    .sort((a, b) => a.dist - b.dist);

  for (let i = 0; i < 10; i++) {
    if (i < sortedBullets.length) {
      const b = sortedBullets[i];
      obs[idx++] = (b.x - ego.x) / CANVAS_W;
      obs[idx++] = (b.y - ego.y) / CANVAS_H;
      obs[idx++] = b.vx / BULLET_SPEED;
      obs[idx++] = b.vy / BULLET_SPEED;
      obs[idx++] = b.ownerId === egoPlayerId ? 1.0 : -1.0;
    } else {
      obs[idx++] = 0;
      obs[idx++] = 0;
      obs[idx++] = 0;
      obs[idx++] = 0;
      obs[idx++] = 0;
    }
  }

  // ─── Local wall grid: 3×3 neighborhood × 2 = 18 values ───
  const egoCol = Math.floor(ego.x / CELL_SIZE);
  const egoRow = Math.floor(ego.y / CELL_SIZE);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = egoRow + dr;
      const c = egoCol + dc;
      if (r >= 0 && r < MAZE_ROWS && c >= 0 && c < MAZE_COLS) {
        obs[idx++] = walls.hasTopWall(r, c) ? 1.0 : 0.0;
        obs[idx++] = walls.hasRightWall(r, c) ? 1.0 : 0.0;
      } else {
        obs[idx++] = 1.0;
        obs[idx++] = 1.0;
      }
    }
  }

  // ─── Metadata (3 values) ───
  obs[idx++] = snapshot.tick / snapshot.maxTicks;
  const egoBullets = bullets.filter(
    (b) => b.ownerId === egoPlayerId
  ).length;
  const oppBullets = bullets.filter(
    (b) => b.ownerId !== egoPlayerId
  ).length;
  obs[idx++] = egoBullets / MAX_BULLETS_PER_TANK;
  obs[idx++] = oppBullets / MAX_BULLETS_PER_TANK;

  return obs;
}
```

### Step 4: Action Decoder (TypeScript)

```typescript
// apps/backend/src/bot/ActionDecoder.ts

import type { InputState } from "@tankbet/game-engine/physics";

/**
 * Maps a discrete action index (0-17) to the InputState
 * sent to the game server. Must match ACTION_TABLE in Python.
 */
const ACTION_TABLE: readonly InputState[] = [
  { up: false, down: false, left: false, right: false, fire: false }, // 0: idle
  { up: true,  down: false, left: false, right: false, fire: false }, // 1: forward
  { up: false, down: true,  left: false, right: false, fire: false }, // 2: backward
  { up: false, down: false, left: true,  right: false, fire: false }, // 3: left
  { up: false, down: false, left: false, right: true,  fire: false }, // 4: right
  { up: true,  down: false, left: true,  right: false, fire: false }, // 5: fwd + left
  { up: true,  down: false, left: false, right: true,  fire: false }, // 6: fwd + right
  { up: false, down: true,  left: true,  right: false, fire: false }, // 7: back + left
  { up: false, down: true,  left: false, right: true,  fire: false }, // 8: back + right
  { up: false, down: false, left: false, right: false, fire: true  }, // 9: fire
  { up: true,  down: false, left: false, right: false, fire: true  }, // 10: fwd + fire
  { up: false, down: true,  left: false, right: false, fire: true  }, // 11: back + fire
  { up: false, down: false, left: true,  right: false, fire: true  }, // 12: left + fire
  { up: false, down: false, left: false, right: true,  fire: true  }, // 13: right + fire
  { up: true,  down: false, left: true,  right: false, fire: true  }, // 14: fwd+left+fire
  { up: true,  down: false, left: false, right: true,  fire: true  }, // 15: fwd+right+fire
  { up: false, down: true,  left: true,  right: false, fire: true  }, // 16: back+left+fire
  { up: false, down: true,  left: false, right: true,  fire: true  }, // 17: back+right+fire
] as const;

export function decodeAction(actionIndex: number): InputState {
  return ACTION_TABLE[actionIndex];
}
```

### Step 5: Server-Side Bot Player

```typescript
// apps/backend/src/bot/BotPlayer.ts

import * as ort from "onnxruntime-node";  // NOT onnxruntime-web
import type { InputState } from "@tankbet/game-engine/physics";
import { encodeState } from "./StateEncoder";
import { decodeAction } from "./ActionDecoder";
import type { GameSnapshot } from "./StateEncoder";

/**
 * Server-side bot player that runs ONNX inference to control a tank.
 * Integrated into TankRoom as a virtual player.
 *
 * Decision frequency: 20Hz (every 3 server ticks at 60Hz).
 * Inference latency: <0.5ms for a ~157K parameter model.
 */
export class BotPlayer {
  private session: ort.InferenceSession | null = null;
  private tickCounter = 0;
  private currentInput: InputState = {
    up: false, down: false, left: false, right: false, fire: false,
  };

  constructor(private modelPath: string) {}

  async initialize(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.modelPath);
  }

  /**
   * Called every server tick (60Hz).
   * Makes a new decision every 3 ticks (20Hz).
   */
  async tick(gameSnapshot: GameSnapshot): Promise<InputState> {
    this.tickCounter++;

    if (this.tickCounter % 3 === 0 && this.session) {
      const observation = encodeState(gameSnapshot);
      const inputTensor = new ort.Tensor("float32", observation, [1, 88]);
      const results = await this.session.run({ observation: inputTensor });
      const qValues = results["q_values"].data as Float32Array;

      // Greedy: pick action with highest Q-value
      let bestAction = 0;
      let bestValue = qValues[0];
      for (let i = 1; i < qValues.length; i++) {
        if (qValues[i] > bestValue) {
          bestValue = qValues[i];
          bestAction = i;
        }
      }

      this.currentInput = decodeAction(bestAction);
    }

    return this.currentInput;
  }

  dispose(): void {
    this.session = null;
  }
}
```

---

## 12. Hyperparameter Reference

### All Parameters in One Place

```python
# ─── Network Architecture ───
hidden_dim = 256                # Hidden layer width (johnnycode8 uses 128-512)
enable_double_dqn = True        # Use DDQN target calculation
enable_dueling_dqn = True       # Split into V(s) + A(s,a) streams

# ─── Core DQN ───
discount_factor = 0.99          # Gamma — universal default
learning_rate = 1e-4            # Adam optimizer (Mnih 2015: 2.5e-4, CleanRL Atari: 1e-4)
mini_batch_size = 64            # Transitions per gradient step (CleanRL: 32-128)
replay_memory_size = 100_000    # Buffer capacity (Mnih 2015: 1M, CleanRL: 10K-100K)
train_frequency = 4             # Gradient step every N env steps (Mnih 2015: 4, CleanRL: 10, SB3: 4)
learning_starts = 10_000        # Buffer warmup before first training step (Mnih 2015: 50K, CleanRL: 10K)

# ─── Target Network ───
network_sync_rate = 1_000       # Hard copy every N steps
# (Mnih 2015: 10K, CleanRL dqn.py: 500, CleanRL dqn_atari.py: 1K)

# ─── Exploration (epsilon-greedy, linear decay per step) ───
epsilon_start = 1.0             # Start fully random
epsilon_end = 0.05              # Floor at 5% random (Mnih 2015: 0.1, CleanRL: 0.01-0.05)
exploration_fraction = 0.5      # Fraction of total_timesteps over which epsilon decays
total_timesteps = 1_000_000     # Total training steps
# Decay is LINEAR PER STEP: epsilon = max(start + slope * t, end)

# ─── Loss & Optimizer ───
loss_fn = "SmoothL1Loss"        # Huber loss — robust to noisy TD targets (PyTorch DQN tutorial, CleanRL)
optimizer = "Adam"              # Universal default
# max_grad_norm = 10            # Optional: gradient clipping (safety net — Huber already caps large errors)

# ─── Environment ───
decision_hz = 20                # Agent decisions per second (every 3 physics ticks)
physics_hz = 60                 # Physics simulation rate
max_episode_ticks = 7200        # 120 seconds × 60Hz

# ─── Reward Function ───
reward_win = 10.0
reward_loss = -10.0
reward_kill = 3.0
reward_death = -3.0
reward_time_penalty = -0.001    # Per physics tick
reward_wasted_bullet = -0.05    # Per expired bullet
                                # Approach reward uses exact PBRS: gamma * Phi(s') - Phi(s) — no scaling factor
reward_wall_penalty = -0.002    # Per tick while touching a wall
```

### Tuning Priority

If the bot isn't learning well, tune in this order:

1. **Reward function** — most impactful. Check for degenerate behaviors first.
2. **Learning rate** — try 2.5e-4 (faster, like CleanRL non-Atari) or 5e-5 (more stable).
3. **Exploration fraction** — if the agent exploits too early, increase to 0.7. If too slow, decrease to 0.3.
4. **Network sync rate** — try 500 (faster adaptation) or 5000 (more stable targets).
5. **Network size** — if underfitting (loss doesn't decrease), try hidden_dim=512.
6. **Batch size** — 32 for faster updates, 128 for more stable gradients.
7. **Buffer size** — increase to 500K if training is unstable.
8. **Train frequency** — try 1 (more updates, slower) or 8 (fewer updates, faster).

---

## 13. Research Sources

### Core Papers

| Paper | Authors | Year | Key Contribution |
|-------|---------|------|-----------------|
| [Playing Atari with Deep RL](https://arxiv.org/abs/1312.5602) | Mnih et al. | 2013 | Original DQN |
| [Human-level control through deep RL](https://www.nature.com/articles/nature14236) | Mnih et al. | 2015 | DQN with target networks + experience replay (Nature) |
| [Deep RL with Double Q-learning](https://arxiv.org/abs/1509.06461) | van Hasselt, Guez, Silver | 2015 | Double DQN — fixes overestimation bias |
| [Dueling Network Architectures](https://arxiv.org/abs/1511.06581) | Wang et al. | 2015 | Dueling DQN — separate V(s) and A(s,a) |
| [Prioritized Experience Replay](https://arxiv.org/abs/1511.05952) | Schaul et al. | 2015 | PER — proportional sampling by TD error |
| [Rainbow: Combining Improvements](https://arxiv.org/abs/1710.02298) | Hessel et al. | 2017 | Combines 6 DQN improvements |
| [Policy invariance under reward transformations](https://people.eecs.berkeley.edu/~pabbeel/cs287-fa09/readings/NgHaradaRussell-shaping-ICML1999.pdf) | Ng, Harada, Russell | 1999 | Potential-based reward shaping theory |

### Implementation References

| Resource | URL | What It Provides |
|----------|-----|-----------------|
| **johnnycode8/dqn_pytorch** | [github.com](https://github.com/johnnycode8/dqn_pytorch) | Primary reference: Double DQN + Dueling in PyTorch |
| johnnycode8/gym_solutions | [github.com](https://github.com/johnnycode8/gym_solutions) | Simpler DQN examples (Frozen Lake, Mountain Car) |
| Gymnasium Custom Env Guide | [gymnasium.farama.org](https://gymnasium.farama.org/introduction/create_custom_env/) | How to create a Gymnasium environment |
| SB3 DQN docs (limitations) | [stable-baselines3.readthedocs.io](https://stable-baselines3.readthedocs.io/en/master/modules/dqn.html) | Confirms SB3 has NO Double/Dueling/PER support |
| CleanRL DQN | [docs.cleanrl.dev](https://docs.cleanrl.dev/rl-algorithms/dqn/) | Single-file reference implementation |
| OpenAI Spinning Up | [spinningup.openai.com](https://spinningup.openai.com/en/latest/) | Official-style RL background, training tips, and debugging heuristics (not DQN-specific) |
| Rainbow is All You Need | [github.com/Curt-Park](https://github.com/Curt-Park/rainbow-is-all-you-need) | Step-by-step notebooks: DQN → Rainbow |
| ONNX Runtime Node | [npmjs.com](https://www.npmjs.com/package/onnxruntime-node) | Server-side Node.js ONNX inference |
| SB3 ONNX Export Guide | [stable-baselines3.readthedocs.io](https://stable-baselines3.readthedocs.io/en/master/guide/export.html) | Pattern for ONNX export (user-defined wrapper, NOT built-in) |

### Related Tank Game RL Projects

| Project | URL | Relevance |
|---------|-----|-----------|
| RL-Tanks | [github.com/amoghskulkarni](https://github.com/amoghskulkarni/RL-Tanks) | 1v1 tank battles with RL (closest analog) |
| tank-battle | [github.com/garlicdevs](https://github.com/garlicdevs/tank-battle) | Multi-agent deep RL for tank combat |
| DQN-DDQN-Pytorch | [github.com/XinJingHao](https://github.com/XinJingHao/DQN-DDQN-Pytorch) | Clean Duel Double DQN implementation |
| Kaixhin/Rainbow | [github.com/Kaixhin](https://github.com/Kaixhin/Rainbow) | Full Rainbow DQN in PyTorch |
