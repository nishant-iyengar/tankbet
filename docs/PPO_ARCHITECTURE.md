# PPO Training Architecture — TankBattle

A comprehensive guide to how every component in the PPO training pipeline works,
how they interact, and why each piece exists.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [The Neural Network](#2-the-neural-network)
3. [The Environment](#3-the-environment)
4. [Rollout Collection](#4-rollout-collection)
5. [Generalized Advantage Estimation (GAE)](#5-generalized-advantage-estimation-gae)
6. [The PPO Update](#6-the-ppo-update)
7. [Reward Normalization](#7-reward-normalization)
8. [How Everything Connects](#8-how-everything-connects)
9. [The Curriculum](#9-the-curriculum)
10. [Hyperparameter Reference](#10-hyperparameter-reference)
11. [Reward Weight Sweep (Optuna)](#11-reward-weight-sweep-optuna)

---

## 1. High-Level Overview

PPO (Proximal Policy Optimization) trains a neural network to play TankBattle by
repeatedly doing two things: **collecting experience** and **learning from it**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRAINING LOOP                                │
│                                                                     │
│   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐       │
│   │   ROLLOUT     │     │     GAE      │     │  PPO UPDATE  │       │
│   │  COLLECTION   │────▶│  ADVANTAGE   │────▶│  (LEARNING)  │       │
│   │  (4096 steps  │     │  COMPUTATION │     │  4 epochs    │       │
│   │   × 8 envs)   │     │              │     │  × 4 batches │       │
│   └──────────────┘     └──────────────┘     └──────┬───────┘       │
│          ▲                                          │               │
│          │              Updated Weights             │               │
│          └──────────────────────────────────────────┘               │
│                                                                     │
│   One iteration = 32,768 environment steps                          │
│   Total training = 10,000,000 steps (~305 iterations)               │
└─────────────────────────────────────────────────────────────────────┘
```

Each iteration:
1. The agent plays the game for 4,096 decision steps across 8 parallel environments
2. GAE computes how much better/worse each action was than expected
3. PPO updates the neural network weights using clipped gradients
4. Repeat with the updated network

This is **on-policy** learning: we collect data, use it once, throw it away, and
collect fresh data with the updated policy. This is less sample-efficient than
off-policy methods (like DQN) but much more stable.

---

## 2. The Neural Network

**File**: `training/ppo.py`

The network has two jobs: decide what to do (actor) and predict how good the
current situation is (critic).

### Architecture

```
                          Observation
                          (141 floats)
                              │
                 ┌────────────┴────────────┐
                 │                          │
          ┌──────▼──────┐           ┌──────▼──────┐
          │   ACTOR      │           │   CRITIC     │
          │   NETWORK    │           │   NETWORK    │
          │              │           │              │
          │  FC(141→256) │           │  FC(141→256) │
          │  ReLU        │           │  ReLU        │
          │  FC(256→256) │           │  FC(256→256) │
          │  ReLU        │           │  ReLU        │
          │  FC(256→18)  │           │  FC(256→1)   │
          └──────┬──────┘           └──────┬──────┘
                 │                          │
          ┌──────▼──────┐           ┌──────▼──────┐
          │   Logits     │           │   Value     │
          │ (18 actions) │           │  (scalar)   │
          └─────────────┘           └─────────────┘
```

The actor and critic are **separate networks** — they share no parameters. This
means the critic learning "this state is bad" doesn't interfere with the actor
learning "but this action might save us."

### Weight Initialization (Orthogonal)

Every linear layer is initialized with orthogonal matrices, not the default
random initialization. This matters because:

```
Default (Kaiming/Xavier):          Orthogonal:
  Weights are random but scaled      Weights form an orthogonal basis
  by fan-in/fan-out.                  (columns are perpendicular unit vectors).

  Problem: gradients can still        Result: gradients flow evenly through
  vanish/explode in deep nets.        all dimensions. No direction is
  Some neurons start "dead."          privileged or suppressed.
```

The `std` parameter controls the scale:

| Layer | std | Why |
|-------|-----|-----|
| Hidden layers | √2 ≈ 1.414 | Compensates for ReLU killing ~50% of activations |
| Actor output | 0.01 | Near-uniform initial policy → high entropy → explores everything |
| Critic output | 1.0 | Allows varied initial value estimates (don't start at zero) |

The actor's tiny `std=0.01` is critical: if the initial policy strongly preferred
certain actions, the agent would never try alternatives. Starting near-uniform
means all 18 actions get roughly equal probability at first.

### Forward Pass

During rollout collection, `get_action()` is called:

```python
logits, value = forward(obs)           # Actor: 141 → 18 logits, Critic: 141 → scalar
dist = Categorical(logits=logits)      # Softmax → probability distribution
action = dist.sample()                 # Sample one of 18 actions
log_prob = dist.log_prob(action)       # log P(action | state) — needed for PPO ratio
return action, log_prob, value
```

During the PPO update, `evaluate()` re-computes log_probs for old actions:

```python
logits, value = forward(obs)
dist = Categorical(logits=logits)
log_prob = dist.log_prob(old_action)   # Probability of the OLD action under NEW policy
entropy = dist.entropy()               # How spread out the distribution is
return log_prob, value, entropy
```

The ratio `new_log_prob - old_log_prob` tells us how much the policy changed.

### Action Space

18 discrete actions = 3 movement × 3 rotation × 2 fire:

```
Movement: { forward, backward, none }  ← 3 options
Rotation: { left, right, none }        ← 3 options
Fire:     { shoot, don't shoot }       ← 2 options
                                         ─────────
                                         3×3×2 = 18
```

---

## 3. The Environment

**File**: `training/tank_env.py`

The environment simulates a top-down tank battle at 60Hz physics, with the agent
making decisions at 20Hz (every 3 physics ticks).

### Observation Space (141 dimensions)

Every observation is normalized to [-1, 1]. The agent sees the world relative to
its own position and facing direction (ego-centric frame).

```
┌─────────────────────────────────────────────────────────────────┐
│                    OBSERVATION VECTOR (141)                      │
├─────────────┬──────┬────────────────────────────────────────────┤
│ Index Range │ Dims │ Description                                │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [0-6]       │   7  │ Ego tank: position, angle, speed, alive,  │
│             │      │ can_fire                                   │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [7-14]      │   8  │ Opponent (ego-relative): relative pos,    │
│             │      │ relative angle, speed, alive, bearing      │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [15-16]     │   2  │ Lives: ego/phase_max, opp/phase_max       │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [17-52]     │  36  │ 6 nearest bullets (6 features each):      │
│             │      │ position, velocity, owner, heading-at-ego  │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [53-102]    │  50  │ 5×5 local wall grid (2 walls per cell:    │
│             │      │ top + right), centered on agent's cell     │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [103-105]   │   3  │ Metadata: time elapsed, bullet counts     │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [106-107]   │   2  │ Line-of-sight: has_LOS, distance          │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [108-119]   │  12  │ Wall raycasts: 12 directions (every 30°), │
│             │      │ distance to nearest wall                   │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [120-122]   │   3  │ BFS navigation: direction + path length   │
│             │      │ (shortest maze path to opponent)           │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [123-124]   │   2  │ Aim alignment: angle from barrel to       │
│             │      │ opponent (cos/sin)                         │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [125-127]   │   3  │ Lead angle: predictive aim accounting     │
│             │      │ for opponent velocity                      │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [128-129]   │   2  │ Shot difficulty: angular width of target, │
│             │      │ time-to-impact                             │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [130-133]   │   4  │ Threat awareness: enemy bullets heading   │
│             │      │ at ego (count, distance, direction)        │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [134-137]   │   4  │ Self-bullet threat: own bullets heading   │
│             │      │ at ego (count, distance, direction)        │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [138-139]   │   2  │ Tactical: fire cooldown remaining,        │
│             │      │ opponent facing angle                      │
├─────────────┼──────┼────────────────────────────────────────────┤
│ [140]       │   1  │ Barrel wall distance: raycast along       │
│             │      │ barrel direction                           │
└─────────────┴──────┴────────────────────────────────────────────┘
```

### Reward Signals (9 active shaping + 7 terminal)

```
TERMINAL REWARDS (sparse, game-changing events):
┌──────────────────────┬────────┬──────────────────────────────────┐
│ Signal               │ Value  │ When                             │
├──────────────────────┼────────┼──────────────────────────────────┤
│ Kill opponent        │ +10.0  │ Agent's bullet kills opponent    │
│ Win game             │ +10.0  │ Opponent out of lives            │
│ Early kill bonus     │ +5.0×f │ f = fraction of time remaining   │
│ Bullet hit           │  +3.0  │ Bullet connects (before kill)    │
│ Reach opponent       │  +5.0  │ Phase 0 only: got within 40px   │
│ Death                │  -3.0  │ Agent loses a life               │
│ Self-kill            │  -5.0  │ Agent's own bullet kills agent   │
│ Loss                 │ -10.0  │ Agent out of lives or timeout    │
└──────────────────────┴────────┴──────────────────────────────────┘

SHAPING REWARDS (dense, per-tick guidance):
┌──────────────────────┬────────┬──────────────────────────────────┐
│ Signal               │ Value  │ When                             │
├──────────────────────┼────────┼──────────────────────────────────┤
│ BFS follow           │ +0.02  │ Moving in BFS direction (capped  │
│                      │        │ at 400 ticks = +8.0 max)         │
│ Good aim             │ +0.10  │ Shot fired with clear LOS + aim  │
│ Bullet near opp      │ +0.50  │ Bullet passes within 50px (1x)   │
│ Dodge near miss      │ +0.10  │ Moved away from enemy bullet     │
│ Dodge self bullet    │ +0.15  │ Moved away from own ricochet     │
│ Fire cost            │ -0.10  │ Per shot fired                   │
│ Time penalty         │ -0.002 │ Per tick (encourages speed)      │
│ Self-bullet proximity│ -0.02  │ Per tick near own bullet          │
│ Stationary penalty   │ -0.01  │ Per tick when camping >30 ticks  │
└──────────────────────┴────────┴──────────────────────────────────┘
```

**Dense/Terminal ratio**: ~12%. This means terminal events dominate the reward
landscape — the shaping signals gently guide behavior but don't overpower the
actual game objectives.

### Episode Lifecycle

```
reset()
  │
  ├─ Pick random maze from 10,000 pre-generated mazes
  ├─ Spawn tanks at random positions (distance per phase config)
  ├─ Initialize lives per phase config
  ├─ Reset bullet list, tick counter, stationary counter
  └─ Return initial observation (141 floats)

step(action)  ← called at 20Hz (every 50ms)
  │
  ├─ Decode action index → (movement, rotation, fire)
  ├─ Get opponent action (random movement + random fire)
  │
  ├─ Run 3 physics ticks at 60Hz:
  │   │
  │   ├─ Move tanks (speed × dt, clamped to arena, wall collisions)
  │   ├─ Handle firing (cooldown check, spawn bullet at barrel tip)
  │   ├─ Update bullets (move, reflect off walls, age)
  │   ├─ Check bullet-tank collisions
  │   │   ├─ Probabilistic self-damage (phase 3: 30%, phase 4+: 100%)
  │   │   └─ Kill/death rewards
  │   └─ Compute per-tick shaping rewards
  │
  ├─ Aggregate rewards from all 3 ticks
  ├─ Check termination (out of lives) or truncation (time limit)
  │
  └─ Return (obs, reward, terminated, truncated, info)
```

### Multi-Life Round System

In phases with multiple lives (Phases 3-6), a kill doesn't end the episode:

```
Kill occurs → loser loses 1 life
  │
  ├─ If loser has lives remaining:
  │   ├─ Pick new maze
  │   ├─ Respawn both tanks
  │   ├─ Clear all bullets
  │   └─ Continue same episode (new round)
  │
  └─ If loser has 0 lives:
      ├─ terminated = True
      ├─ Winner gets reward_win (+10.0)
      └─ Loser gets reward_loss (-10.0)
```

---

## 4. Rollout Collection

**File**: `training/rollout_buffer.py`

Before learning can happen, the agent needs experience. A rollout is a batch of
gameplay data collected by running the current policy.

### The Buffer

```
Pre-allocated tensors (all on CPU):

┌───────────┬─────────────────┬──────────────────────────────────┐
│ Tensor    │ Shape           │ Contents                         │
├───────────┼─────────────────┼──────────────────────────────────┤
│ obs       │ (4096, 8, 141)  │ Observations before each action  │
│ actions   │ (4096, 8)       │ Actions taken (0-17)             │
│ rewards   │ (4096, 8)       │ Rewards received after action    │
│ dones     │ (4096, 8)       │ Done flags from previous step    │
│ values    │ (4096, 8)       │ V(obs) from critic               │
│ log_probs │ (4096, 8)       │ log π(action|obs) from actor     │
├───────────┼─────────────────┼──────────────────────────────────┤
│ advantages│ (4096, 8)       │ Computed after rollout (GAE)     │
│ returns   │ (4096, 8)       │ Computed after rollout (GAE)     │
└───────────┴─────────────────┴──────────────────────────────────┘

4096 = rollout steps per collection
8    = parallel environments
141  = observation dimensions
```

### Collection Flow (one step)

```
Step t of rollout:

  ┌─────────┐     get_action()     ┌─────────┐
  │  obs_t  │────────────────────▶│  Actor   │──▶ action_t, log_prob_t
  │ (8,141) │                      │  Critic  │──▶ value_t
  └─────────┘                      └─────────┘

  Buffer stores: obs_t, action_t, done_{t-1}, value_t, log_prob_t
                                    ▲
                                    │ done from PREVIOUS step
                                    │ (was this obs a reset state?)

  ┌─────────┐     envs.step()      ┌─────────────────┐
  │action_t │────────────────────▶│ 8 parallel envs  │
  │  (8,)   │                      │  (AsyncVector)   │
  └─────────┘                      └───────┬─────────┘
                                           │
                            ┌──────────────┼──────────────┐
                            ▼              ▼              ▼
                     new_obs (8,141)  rewards (8,)  done_flags (8,)

  Buffer stores: rewards at buffer.rewards[t]
  Update: states_t ← new_obs, dones_t ← done_flags
```

### Storage Convention (CleanRL Pattern)

This is subtle but critical for correct GAE computation:

```
Time:        t=0          t=1          t=2          t=3
            ┌────┐       ┌────┐       ┌────┐       ┌────┐
obs[]       │ s0 │       │ s1 │       │ s2 │       │ s3 │
            └────┘       └────┘       └────┘       └────┘
dones[]     │  0 │       │  0 │       │  1 │       │  0 │
            └────┘       └────┘       └────┘       └────┘
            │    │       │    │       │    │
            │ a0 │       │ a1 │       │ a2 │       ← actions taken
            │    ▼       │    ▼       │    ▼
rewards[]   │ r0 │       │ r1 │       │ r2 │       ← rewards received
            └────┘       └────┘       └────┘

dones[2]=1 means s2 is a RESET state (episode ended between t=1 and t=2).
This tells GAE: "don't bootstrap V(s2) into the advantage at t=1."
```

---

## 5. Generalized Advantage Estimation (GAE)

**File**: `rollout_buffer.py`, `compute_advantages()`

After collecting a full rollout, we need to answer: "For each action we took,
how much better or worse was it compared to what we expected?"

### The Problem GAE Solves

Two extreme ways to estimate advantage:

```
1-STEP TD (low variance, high bias):
  A_t = r_t + γ·V(s_{t+1}) - V(s_t)

  ✓ Low variance: uses only one reward
  ✗ High bias: relies on V being accurate (it isn't early in training)


MONTE CARLO (zero bias, high variance):
  A_t = (r_t + γ·r_{t+1} + γ²·r_{t+2} + ... + γⁿ·r_T) - V(s_t)

  ✓ Zero bias: uses actual returns
  ✗ High variance: sum of many noisy rewards, huge variance


GAE (tunable bias-variance tradeoff):
  A_t = δ_t + (γλ)·δ_{t+1} + (γλ)²·δ_{t+2} + ...

  Where δ_t = r_t + γ·V(s_{t+1}) - V(s_t)   ← 1-step TD error

  λ=0 → pure 1-step TD
  λ=1 → pure Monte Carlo
  λ=0.98 (ours) → leans Monte Carlo but with exponential decay
```

### The Reverse Sweep

GAE is computed backwards through the rollout buffer:

```
                    ┌──── Bootstrap from critic ────┐
                    │                               │
Time:   t=0    t=1    t=2    ...    t=4094   t=4095   (after)
        ┌──┐   ┌──┐   ┌──┐          ┌──┐     ┌──┐
  δ:    │δ0│   │δ1│   │δ2│    ...   │δN-1│   │δN │
        └──┘   └──┘   └──┘          └──┘     └──┘
                                               │
  Sweep direction: ◀─────────────────────────────
                                               │
  last_gae = 0                                 │
  For t = 4095 down to 0:                      │
    if t == 4095:                               ▼
      next_value = last_value (from critic on final obs)
      next_done = last_done
    else:
      next_value = values[t+1]
      next_done = dones[t+1]

    δ_t = rewards[t] + γ · (1 - next_done) · next_value - values[t]
    last_gae = δ_t + γ · λ · (1 - next_done) · last_gae
    advantages[t] = last_gae

  returns = advantages + values
```

The `(1 - next_done)` term is crucial: when an episode ends, the advantage
accumulator resets. Future rewards from a **different episode** must not bleed
into the current advantage estimate.

### Why γ=0.995 and λ=0.98?

```
Effective horizon = 1 / (1 - γ) = 1 / 0.005 = 200 decision steps

At 20Hz decisions, 200 steps = 10 seconds of gameplay.
Our episodes last 20-120 seconds, so the agent can "see" ~10 seconds ahead.

With γ=0.99 (standard):  horizon = 100 steps = 5 seconds  ← too short
With γ=0.999:            horizon = 1000 steps = 50 seconds ← too noisy

λ=0.98 means GAE looks ~50 steps deep before the exponential decay kills
the signal. This balances using real returns (low bias) with not accumulating
too much noise (low variance).
```

### Returns vs Advantages

```
returns[t] = advantages[t] + values[t]

This recovers the "lambda-return" — the GAE-weighted estimate of total
future discounted reward from state s_t.

Used for:
  - advantages → policy loss (which actions are better/worse)
  - returns    → value loss (what should V(s) predict)
```

---

## 6. The PPO Update

**File**: `training/ppo_trainer.py`

After computing advantages, we update the network. This is where all the
components come together.

### Minibatch Preparation

```
Rollout buffer (4096 steps × 8 envs):
  ┌─────────────────────────────┐
  │  obs       (4096, 8, 141)   │
  │  actions   (4096, 8)        │     Flatten
  │  log_probs (4096, 8)        │ ──────────▶  Everything becomes (32768, ...)
  │  advantages(4096, 8)        │
  │  returns   (4096, 8)        │     Normalize advantages:
  │  values    (4096, 8)        │     adv = (adv - mean) / (std + 1e-8)
  └─────────────────────────────┘
                                      Shuffle indices randomly
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                         MB #1 (8192)  MB #2 (8192)  ... MB #4 (8192)
```

Advantage normalization ensures every update has similarly-scaled gradients,
regardless of whether the agent is in Phase 0 (small rewards) or Phase 6
(large rewards). Without this, learning rate would need to change per phase.

### The Three Losses

Each minibatch produces three loss terms:

```
┌─────────────────────────────────────────────────────────────────┐
│                        PPO UPDATE                               │
│                                                                 │
│  Minibatch: obs (8192, 141), actions (8192), etc.               │
│                                                                 │
│  Forward pass:                                                  │
│    new_log_probs, new_values, entropy = model.evaluate(obs, a)  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 1. POLICY LOSS (Clipped Surrogate)                      │    │
│  │                                                         │    │
│  │    ratio = exp(new_log_prob - old_log_prob)              │    │
│  │                                                         │    │
│  │    unclipped = -advantage × ratio                       │    │
│  │    clipped   = -advantage × clamp(ratio, 0.8, 1.2)     │    │
│  │    pg_loss   = max(unclipped, clipped).mean()           │    │
│  │                                                         │    │
│  │    Prevents policy from changing too much in one step.  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 2. VALUE LOSS (Clipped)                                 │    │
│  │                                                         │    │
│  │    unclipped = (new_value - target_return)²             │    │
│  │    clipped_v = old_value + clamp(new - old, -0.2, 0.2) │    │
│  │    clipped   = (clipped_v - target_return)²             │    │
│  │    v_loss    = 0.5 × max(unclipped, clipped).mean()    │    │
│  │                                                         │    │
│  │    Prevents value function from making huge jumps.      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 3. ENTROPY BONUS                                        │    │
│  │                                                         │    │
│  │    entropy_loss = entropy.mean()                        │    │
│  │                                                         │    │
│  │    Encourages exploration by penalizing certainty.      │    │
│  │    High entropy = spread-out action probabilities.      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Total loss = pg_loss + 0.5 × v_loss - 0.03 × entropy_loss     │
│                                                                 │
│  Backprop:                                                      │
│    optimizer.zero_grad()                                        │
│    loss.backward()                                              │
│    clip_grad_norm_(params, max_norm=0.5)   ← gradient clipping  │
│    optimizer.step()                                             │
└─────────────────────────────────────────────────────────────────┘

This runs 4 epochs × 4 minibatches = 16 gradient steps per rollout.
```

### Deep Dive: Policy Clipping

The clipped surrogate is the heart of PPO. Here's exactly what happens:

```
ratio = π_new(a|s) / π_old(a|s)

Case 1: GOOD ACTION (advantage > 0)
  ──────────────────────────────────
  The policy wants to increase ratio (make this action more likely).

  Without clipping: ratio could go to 5.0, 10.0, 100.0...
    → catastrophic policy change, training collapses

  With clipping: ratio capped at 1.2
    → policy can increase probability by at most 20% per update

  loss = max(-adv × ratio, -adv × clamp(ratio, 0.8, 1.2))
         ────────────────  ─────────────────────────────────
         if ratio > 1.2,    this is smaller (less negative),
         this keeps         so max() picks THIS term,
         growing            effectively capping the gradient


Case 2: BAD ACTION (advantage < 0)
  ──────────────────────────────────
  The policy wants to decrease ratio (make this action less likely).

  Without clipping: ratio could go to 0.01, 0.001...
    → action probability collapses to near-zero, can never recover

  With clipping: ratio floored at 0.8
    → policy can decrease probability by at most 20% per update


Case 3: RATIO NEAR 1.0
  ──────────────────────────────────
  Clamp doesn't activate. Behaves like vanilla policy gradient.
```

The `max()` is **pessimistic**: it ensures clipping only **restricts** updates,
never helps them. If the unclipped loss is already worse (higher), we use that.

### Deep Dive: Value Function Clipping

```
Problem: During training, the value function can make a huge jump from
V_old(s) = 5.0 to V_new(s) = 50.0 in one update. This destabilizes
advantage estimation because:

  advantage = reward + γ·V(s') - V(s)

If V changes dramatically between rollout collection and the PPO update,
the advantages computed during GAE (using old V) are inconsistent with
the new V being trained on.

Solution: Clip value updates to stay within ε of the old prediction.

  v_clipped = V_old + clamp(V_new - V_old, -0.2, +0.2)

  Take max of clipped and unclipped loss (pessimistic — always
  penalize large changes):

  v_loss = 0.5 × max((V_new - R)², (v_clipped - R)²)

This prevents the value function from "overshooting" its targets.
```

### Gradient Clipping

```
torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=0.5)

After loss.backward(), all gradients are computed. This rescales them so
the global gradient norm (L2 norm across all parameters) never exceeds 0.5.

If ||∇L|| = 2.0 and max_norm = 0.5:
  scale = 0.5 / 2.0 = 0.25
  All gradients multiplied by 0.25

This prevents gradient explosions from outlier transitions (e.g., a rare
self-kill giving -8.0 reward in a batch where everything else is ~0.02).
```

### Learning Rate Annealing

```
lr_now = base_lr × (1 - global_step / total_steps)

Step 0:           lr = 2.5e-4 (full speed)
Step 5,000,000:   lr = 1.25e-4 (half speed)
Step 10,000,000:  lr = 0 (stop learning)

                    Learning Rate Schedule
    2.5e-4 ┤━━━━━━━
           │        ━━━━━
           │              ━━━━━
           │                    ━━━━━
           │                          ━━━━━
         0 ┤                                ━━━━━
           └──────────────────────────────────────
           0              5M              10M steps

Why anneal? Early in training, the policy is random and needs big updates.
Later, the policy is good and needs fine-tuning. Decaying to zero prevents
overfitting to the last few batches of experience.
```

---

## 7. Reward Normalization

**File**: `ppo_trainer.py` (via `gym.wrappers.NormalizeReward`)

### The Problem

Raw reward magnitudes vary wildly across phases and gameplay:

```
Phase 0 (pathfinding):    rewards ∈ [-12, +15]   (small range)
Phase 6 (full game):      rewards ∈ [-96, +37]   (huge range)

Even within one phase, a typical step gives -0.002 (time penalty)
but a kill gives +13.0. That's a 6500× difference.
```

Without normalization, the value function struggles to learn — it needs to
predict values spanning orders of magnitude, and the critic loss is dominated
by outlier transitions.

### How NormalizeReward Works

```
Gymnasium wrapper applied PER environment:

  ┌──────────────────────────────────────────────────────────┐
  │                   NormalizeReward                         │
  │                                                          │
  │  Maintains running statistics of DISCOUNTED RETURNS:     │
  │                                                          │
  │    discounted_return = r + γ × discounted_return         │
  │    (reset to 0 at episode boundaries)                    │
  │                                                          │
  │  Tracks running mean and variance of these returns:      │
  │    RunningMeanStd:                                       │
  │      mean:  exponential moving average                   │
  │      var:   exponential moving variance                  │
  │      count: number of samples seen                       │
  │                                                          │
  │  Normalizes each reward:                                 │
  │    r_normalized = r / sqrt(var + ε)                      │
  │                                                          │
  │  Note: divides by std, does NOT subtract mean.           │
  │  This preserves the sign of rewards (positive stays      │
  │  positive, negative stays negative).                     │
  └──────────────────────────────────────────────────────────┘
```

### Interaction with GAE

```
Raw reward from env:        r = +10.0 (kill)
After NormalizeReward:      r_norm = 10.0 / sqrt(var)  ← maybe ≈ 2.5

GAE uses normalized rewards:
  δ_t = r_norm_t + γ · V(s_{t+1}) - V(s_t)

The value function learns to predict normalized returns.
Advantages are in normalized units.

This means:
  ✓ Consistent gradient magnitudes across phases
  ✓ Policy loss and value loss stay in similar ranges
  ✓ Learning rate doesn't need per-phase tuning
```

### Saving/Restoring on Resume

The running statistics (mean, var, count) are saved in checkpoints and
restored when training resumes. Without this, the normalizer would reset
with fresh statistics, causing a temporary training disturbance as it
re-learns the reward scale.

---

## 8. How Everything Connects

### Complete Data Flow for One Training Iteration

```
PHASE 1: ROLLOUT COLLECTION (4096 decision steps × 8 envs)
═══════════════════════════════════════════════════════════

    ┌─────────────┐
    │  8 Tank     │    Each env runs independently:
    │  Environments│   - Random maze selection
    │  (parallel)  │   - 60Hz physics, 20Hz decisions
    │              │   - NormalizeReward wrapper on each
    └──────┬──────┘
           │ obs (8, 141)
           ▼
    ┌─────────────┐
    │ ActorCritic │    Forward pass (no gradients):
    │  Network    │    - Actor: obs → logits → sample action
    │             │    - Critic: obs → value estimate
    └──────┬──────┘
           │ action (8,), log_prob (8,), value (8,)
           ▼
    ┌─────────────┐
    │  Rollout    │    Stores: obs, action, normalized reward,
    │  Buffer     │    done, value, log_prob
    │ (4096×8)    │    All on CPU
    └─────────────┘

    Repeat 4096 times. Track episode rewards, wins, phase progress.


PHASE 2: GAE ADVANTAGE COMPUTATION
═══════════════════════════════════

    ┌─────────────┐
    │  Rollout    │    Backward sweep through 4096 steps:
    │  Buffer     │
    │             │    δ_t = r_t + γ·(1-d)·V_{t+1} - V_t
    │  rewards    │──▶ A_t = δ_t + γλ·(1-d)·A_{t+1}
    │  values     │    R_t = A_t + V_t
    │  dones      │
    └──────┬──────┘
           │ advantages (4096, 8), returns (4096, 8)
           ▼

PHASE 3: MINIBATCH PREPARATION
═══════════════════════════════

    Flatten: (4096, 8, ...) → (32768, ...)
    Normalize advantages: (adv - mean) / (std + 1e-8)
    Shuffle randomly
    Split into 4 minibatches of 8192


PHASE 4: PPO UPDATE (4 epochs × 4 minibatches = 16 gradient steps)
══════════════════════════════════════════════════════════════════

    For each epoch:
      For each minibatch (8192 samples):

        ┌─────────────┐
        │ ActorCritic │    Forward pass (WITH gradients):
        │  (current   │    - Re-evaluate old actions under new policy
        │   weights)  │    - Get new log_probs, values, entropy
        └──────┬──────┘
               │
               ▼
        ┌─────────────────────────────────────┐
        │  Compute 3 losses:                  │
        │                                     │
        │  pg_loss:  clipped surrogate        │──▶ "Is the policy improving?"
        │  v_loss:   clipped value MSE        │──▶ "Is the critic accurate?"
        │  entropy:  distribution spread      │──▶ "Is the agent exploring?"
        │                                     │
        │  total = pg + 0.5·v - 0.03·entropy  │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Backprop:                          │
        │  1. Compute gradients               │
        │  2. Clip gradient norm to 0.5       │
        │  3. Adam optimizer step             │
        └─────────────────────────────────────┘


PHASE 5: LOGGING
════════════════

    TensorBoard:
    ├─ losses/policy_loss     ← should decrease over training
    ├─ losses/value_loss      ← should decrease (critic gets better)
    ├─ losses/entropy         ← should decrease slowly (not collapse)
    ├─ losses/clip_fraction   ← should be 0.1-0.3 (clipping is active)
    ├─ charts/episode_reward  ← should increase
    ├─ charts/win_rate        ← should approach promotion threshold
    ├─ charts/explained_var   ← should approach 1.0 (critic is good)
    └─ charts/learning_rate   ← linear decay
```

### The Feedback Loop

```
                     ┌──────────────────────────────┐
                     │                              │
                     ▼                              │
    ┌───────────┐  policy  ┌───────────┐  rewards  ┌┴──────────┐
    │  Actor    │────────▶│Environment│─────────▶│  Buffer   │
    │  Network  │         │ (8 tanks) │          │  + GAE    │
    └───────────┘         └───────────┘          └─────┬─────┘
         ▲                                             │
         │                advantages                   │
         │ ┌───────────┐    +       ┌──────────┐       │
         └─┤   PPO     │◀──────────┤  Value   │◀──────┘
           │   Update  │  returns   │  Targets │ returns
           └───────────┘           └──────────┘

  1. Actor decides actions → Environment produces rewards
  2. Rewards go into buffer → GAE computes advantages + returns
  3. Advantages tell the actor which actions were good/bad
  4. Returns tell the critic what the true value was
  5. Actor gets better at choosing actions → better rewards
  6. Critic gets better at predicting value → better advantages
  7. Better advantages → more accurate policy updates
  8. Cycle continues...

  The critic bootstraps the actor:
    Good critic → accurate advantages → stable policy updates
    Bad critic → noisy advantages → erratic policy updates

  The actor bootstraps the critic:
    Good actor → consistent trajectories → easier value prediction
    Bad actor → random trajectories → critic can't learn patterns
```

### Why Each Stabilization Mechanism Exists

```
Without stabilization, this loop is fragile:

  ┌──────────────────────────────────────────────────────────────┐
  │                   FAILURE MODE                → FIX          │
  ├──────────────────────────────────────────────────────────────┤
  │ Policy changes too much in one update         → PPO clipping │
  │   (old advantages become meaningless)           (ε=0.2)     │
  │                                                              │
  │ Value function jumps wildly                   → Value clip   │
  │   (advantages become noisy)                     (ε=0.2)     │
  │                                                              │
  │ Gradients explode from outlier transitions    → Grad clip    │
  │   (training diverges)                           (norm=0.5)  │
  │                                                              │
  │ Reward scale varies across phases             → Reward norm  │
  │   (critic can't learn, LR wrong)               (running σ)  │
  │                                                              │
  │ Advantages have different scales per batch    → Adv norm     │
  │   (gradient magnitude is inconsistent)          (per-batch)  │
  │                                                              │
  │ Agent converges to first good strategy        → Entropy bonus│
  │   (never explores alternatives)                 (coef=0.03) │
  │                                                              │
  │ Gradients vanish/explode in deep network      → Orthogonal  │
  │   (some neurons never activate)                 init (√2)   │
  │                                                              │
  │ Policy starts biased toward some actions      → Actor init   │
  │   (never tries others)                          (std=0.01)  │
  │                                                              │
  │ Learning rate too high late in training        → LR anneal   │
  │   (policy oscillates near convergence)          (linear→0)  │
  └──────────────────────────────────────────────────────────────┘
```

---

## 9. The Four Normalizations (and Why Each Exists)

PPO uses four different kinds of normalization, each solving a distinct problem.
They operate at different stages of the pipeline and are not redundant.

```
┌───────────────────────────────────────────────────────────────────────┐
│                   WHERE EACH NORMALIZATION ACTS                       │
│                                                                       │
│                                                                       │
│   Environment          NormalizeReward         Rollout Buffer          │
│   ┌──────────┐         ┌──────────┐           ┌──────────────┐       │
│   │ Raw      │  ①      │Normalized│   ②       │  Observation │       │
│   │ reward   │────────▶│ reward   │──────────▶│  Normalization│       │
│   │ (+10.0)  │ Reward  │ (+2.5)   │  Stored   │  (in env)    │       │
│   └──────────┘ Norm    └──────────┘  in buf   └──────────────┘       │
│                                                                       │
│                        GAE Output              PPO Update             │
│                        ┌──────────┐           ┌──────────────┐       │
│                   ③    │Normalized│    ④      │  Gradient    │       │
│               ────────▶│Advantages│──────────▶│  Clipping    │       │
│               Advantage│ (μ=0,σ=1)│  Gradient │  (norm≤0.5)  │       │
│               Norm     └──────────┘  Norm     └──────────────┘       │
│                                                                       │
│   ① Reward Normalization:    Scale raw rewards to consistent range    │
│   ② Observation Normalization: All inputs in [-1, 1]  (built into env)│
│   ③ Advantage Normalization:  Zero-mean, unit-variance advantages     │
│   ④ Gradient Clipping:        Cap gradient magnitude                  │
└───────────────────────────────────────────────────────────────────────┘
```

### Normalization 1: Observation Normalization (in tank_env.py)

**What**: Every observation value is scaled to [-1, 1] inside the environment.

**How**: Each raw value is divided by its natural maximum:
- Positions: `x / ARENA_WIDTH`, `y / ARENA_HEIGHT`
- Speeds: `speed / TANK_SPEED`
- Distances: `dist / arena_diagonal`
- Angles: represented as `(cos, sin)` pairs (naturally [-1, 1])
- Binary flags: 0.0 or 1.0
- Lives: `lives / phase_max_lives`

**Why this matters for the neural network**:

```
Without observation normalization:
  Input: [540.0, 360.0, 0.87, 0.5, 300.0, 1.0, 0.0, ...]
          ─────  ─────                 ─────
          huge   huge                  huge
          values values                value

  Problem: The first linear layer (FC 141→256) multiplies each input by
  a weight. If x_position=540 and cos_angle=0.87, then the position
  dominates the weighted sum. The network ignores small-valued features.

  Also: gradients flow proportional to input magnitude. Large inputs →
  large gradients → unstable updates. Small inputs → tiny gradients →
  features never learned.

With observation normalization:
  Input: [0.50, 0.50, 0.87, 0.5, 1.0, 1.0, 0.0, ...]
          ────  ────              ───
          all values roughly same magnitude

  All features contribute equally. The network can learn which ones
  matter through its weights, not be forced by input scale.
```

This is done manually in the env rather than with a wrapper because the
observation space is hand-designed — we know the exact ranges.

### Normalization 2: Reward Normalization (NormalizeReward wrapper)

**What**: Raw rewards are divided by the running standard deviation of
discounted episode returns.

**How** (inside `gym.wrappers.NormalizeReward`):

```python
# After each step:
discounted_return = reward + gamma * discounted_return  # running return
# At episode boundaries, discounted_return resets to 0

# RunningMeanStd tracks:
#   mean:  exponential moving average of discounted_return
#   var:   exponential moving variance of discounted_return
#   count: number of updates

# Normalize reward:
reward_normalized = reward / sqrt(var + epsilon)
```

**Why divide by std but NOT subtract mean?**

```
If we subtracted mean:
  A kill reward of +10.0, with mean return of +5.0:
    normalized = (10.0 - 5.0) / std = small positive number

  A death penalty of -3.0:
    normalized = (-3.0 - 5.0) / std = large NEGATIVE number

  Problem: subtracting mean shifts the reward center. Positive rewards
  become less positive, negative rewards become more negative. This
  distorts the relative value of outcomes.

By only dividing by std:
  We preserve the sign and relative ranking of rewards.
  A +10.0 kill is always better than a +0.5 near-miss.
  We only change the SCALE, not the CENTER.
```

**Why normalize by return variance, not raw reward variance?**

```
Raw reward variance: Var(r_t)
  Problem: most rewards are tiny (-0.002 time penalty) with rare
  large spikes (+10.0 kill). The variance is dominated by the rare
  events. Normalizing by this variance would make the small rewards
  microscopic and the large ones only slightly scaled.

Return variance: Var(Σ γᵗ rₜ)
  This tracks the scale of CUMULATIVE rewards, which is what the
  value function actually predicts. The normalized rewards produce
  returns that are naturally scaled for the value function.
```

**Why this matters across phases**:

```
Phase 0 returns: [-12, +15]    → sqrt(var) ≈ 8
Phase 6 returns: [-96, +37]    → sqrt(var) ≈ 35

Without normalization:
  Phase 0: value function predicts values ∈ [-12, 15]
  Phase 6: value function predicts values ∈ [-96, 37]
  → After promotion, the value function's predictions are wildly wrong
  → GAE advantages are meaningless
  → Policy update goes haywire

With normalization:
  Phase 0: normalized returns ∈ [-1.5, +1.9]
  Phase 6: normalized returns ∈ [-2.7, +1.1]
  → Similar range! The value function transfers between phases.
  → The same learning rate works for all phases.
```

### Normalization 3: Advantage Normalization (in rollout_buffer.py)

**What**: After GAE computation, advantages are standardized to mean=0, std=1
across the entire batch.

```python
advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)
```

**Why this is different from reward normalization**:

```
Reward normalization:   Scales individual rewards at collection time.
Advantage normalization: Scales the LEARNING SIGNAL at update time.

They serve different purposes:
  - Reward norm keeps the value function's target scale consistent.
  - Advantage norm keeps the policy gradient's magnitude consistent.
```

**Why per-batch, not per-minibatch?**

```
Per-minibatch normalization:
  Minibatch 1: all good transitions → after norm, half become "bad"
  Minibatch 2: all bad transitions  → after norm, half become "good"

  Problem: artificially creates positive and negative advantages
  within each minibatch. Bad transitions get REWARDED if they happen
  to be in a batch of worse transitions.

Per-batch normalization:
  Normalize once over all 32,768 samples.
  Split into minibatches AFTER normalization.

  Each minibatch preserves the global ranking:
    truly good transitions → positive advantage
    truly bad transitions  → negative advantage
```

**Why normalize advantages at all?**

```
Policy gradient: ∇J = E[advantage × ∇log π(a|s)]

The gradient magnitude depends on advantage magnitude:
  Large advantages → large gradients → aggressive update
  Small advantages → small gradients → tiny update

If advantage scale changes across training:
  - Early training: advantages ∈ [-0.1, +0.1] → tiny gradients
  - Late training: advantages ∈ [-50, +30] → huge gradients
  → Need different learning rates at different stages

With normalization:
  Advantages always ∈ [-3, +3] (roughly)
  Gradient magnitude is consistent
  One learning rate works throughout training
```

### Normalization 4: Gradient Clipping (in ppo_trainer.py)

**What**: After backpropagation, if the total gradient norm exceeds 0.5,
all gradients are proportionally scaled down.

```python
torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=0.5)

# If gradient norm = 2.0:
#   scale_factor = 0.5 / 2.0 = 0.25
#   all gradients *= 0.25
# If gradient norm = 0.3:
#   no scaling (already within limit)
```

**Why this is the last line of defense**:

```
Even with reward normalization + advantage normalization, individual
minibatches can have outlier gradients:

  Scenario: A minibatch happens to contain:
    - 5 self-kill events (-8.0 each)
    - 2 timeout losses (-10.0 each)
    - Mostly negative advantages

  Result: The loss function produces a very large gradient that would
  push the network weights far from their current position.

  Without gradient clipping:
    The optimizer takes a huge step → weights change drastically →
    the policy collapses → training may never recover.

  With gradient clipping:
    The gradient direction is preserved (still learns from the outlier)
    but the step SIZE is bounded. The network changes incrementally.
```

**Why norm clipping, not value clipping?**

```
Value clipping: clamp each gradient independently to [-max, max]
  Problem: changes the gradient DIRECTION. If grad = [100, 0.01]
  and we clamp to [-1, 1], we get [1, 0.01]. The first dimension
  dominates. The gradient no longer points toward the true minimum.

Norm clipping: scale ALL gradients by the same factor
  If grad = [100, 0.01] and norm = 100, scale = 0.5/100 = 0.005:
  Result: [0.5, 0.00005]. Same DIRECTION, smaller MAGNITUDE.
  The optimizer still moves toward the minimum, just slower.
```

### How the Four Normalizations Interact

```
Complete flow for a single reward signal:

  +10.0 (raw kill reward)
    │
    ├─ ① Observation norm: N/A (this is a reward, not an observation)
    │
    ├─ ② Reward normalization: 10.0 / sqrt(var) ≈ 2.5
    │    Stored in buffer as 2.5
    │
    ├─ GAE computation: δ_t = 2.5 + γ·V(s') - V(s)
    │    advantage_t ≈ 1.8 (after GAE accumulation)
    │
    ├─ ③ Advantage normalization: (1.8 - μ_batch) / σ_batch ≈ 0.9
    │    This advantage is "0.9 standard deviations above mean"
    │
    ├─ Policy gradient: loss = -0.9 × ratio
    │    Gradient computed via backprop
    │
    └─ ④ Gradient clipping: if ||∇|| > 0.5, scale down
         Final gradient applied to weights via Adam

  Each normalization handles a different scale issue:
    ② keeps rewards comparable across phases
    ③ keeps advantages comparable across batches
    ④ keeps gradient steps bounded regardless of batch composition
```

---

## 10. The Curriculum

**File**: `training/phase_config.py`

The agent progresses through 7 phases of increasing difficulty. Each phase
changes environment rules but keeps reward values identical.

```
Phase 0                Phase 1              Phase 2
PATHFINDING            SHOOT NEARBY         NAV + SHOOT
┌─────────┐            ┌─────────┐          ┌─────────┐
│  ★   ●  │            │  ★ ← ● │          │★        │
│  ↓      │            │  pew!   │          │ ↓       │
│  ★→→→●  │            │         │          │  ↘      │
│ navigate│            │  aim    │          │   ● pew!│
│  to opp │            │  & kill │          │far range│
└─────────┘            └─────────┘          └─────────┘
no shooting            close spawn          full arena
win by reach           moving opp           any distance

    │ 90% win rate         │ 90%                │ 90%
    ▼                      ▼                    ▼

Phase 3                Phase 4              Phase 5
BULLET SAFETY          BULLET SAFETY        DODGE
(EASY)                 (FULL)
┌─────────┐            ┌─────────┐          ┌─────────┐
│ ★ pew!  │            │ ★ pew!  │          │ ★  ← ←●│
│   ↙     │            │   ↙     │          │ pew!    │
│  ●(30%) │            │  ●(100%)│          │  opp    │
│ 2 lives │            │ 2 lives │          │  fires  │
│self-dmg │            │self-dmg │          │  back!  │
└─────────┘            └─────────┘          └─────────┘
30% chance own         100% chance          opp shoots
bullet hurts you       own bullet hurts     every 3 sec

    │ 90%                  │ 90%                │ 90%
    ▼                      ▼                    ▼

                    Phase 6
                    FULL GAME
                    ┌─────────┐
                    │ ★ ←→ ● │
                    │ pew pew │
                    │ 3 lives │
                    │ no mercy│
                    │ 2 min   │
                    └─────────┘
                    full opponent
                    no fire limit
                    terminal phase
```

### Auto-Promotion Logic

```python
# Checked after every episode completion:

if auto_promote and current_phase < 6:
    cfg = PHASE_CONFIGS[current_phase]

    if (phase_episode_count >= cfg.promote_min_episodes    # enough data
        and len(win_history) >= 200                         # enough recent games
        and sum(win_history) / 200 >= cfg.promote_win_rate  # winning enough
    ):
        # Promote!
        current_phase += 1
        close old envs
        create new envs with new phase config
        reset win tracking
```

### Why Rewards Stay Uniform

If Phase 3 had different reward weights than Phase 2, the agent would need to
re-learn value estimates at every phase transition. With uniform rewards:

- The critic's value predictions carry over between phases
- The reward normalizer's running statistics stay relevant
- The actor's "kill is good, death is bad" knowledge transfers intact

Only the environment rules change — the agent faces new challenges but the
reward language it learned remains consistent.

---

## 10. Hyperparameter Reference

### Network Architecture

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Hidden dim | 256 | 141 inputs → needs capacity for spatial reasoning |
| Hidden layers | 2 per network | Enough depth without vanishing gradients |
| Activation | ReLU | Simple, fast, works with orthogonal init |
| Architecture | Separate actor/critic | Prevents critic interference with policy |
| Actor output init | std=0.01 | Near-uniform initial policy |
| Critic output init | std=1.0 | Allows varied initial predictions |
| Hidden init | std=√2 | Compensates for ReLU dead neurons |

### PPO Hyperparameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Rollout steps | 4096 | ~3.4 min gameplay per update (enough episodes) |
| Num envs | 8 | 32K batch size, good GPU utilization |
| Num epochs | 4 | Reuse each batch 4 times |
| Num minibatches | 4 | 8192 samples per gradient step |
| Clip epsilon | 0.2 | Standard PPO trust region |
| Entropy coef | 0.03 | Above CleanRL default (more exploration) |
| Value coef | 0.5 | Standard weighting of critic loss |
| Max grad norm | 0.5 | Prevents gradient explosions |

### Optimization

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Optimizer | Adam | Standard for RL, handles sparse gradients |
| Base LR | 2.5e-4 | CleanRL default, works for discrete control |
| Adam epsilon | 1e-5 | Prevents division by tiny values |
| LR schedule | Linear decay to 0 | Fine-tune near convergence |
| Total steps | 10,000,000 | ~305 PPO updates |

### GAE / Discounting

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Gamma (γ) | 0.995 | Long horizon (~200 steps ≈ 10s lookahead) |
| GAE Lambda (λ) | 0.98 | Leans Monte Carlo, ~50 step effective depth |

### Curriculum

| Phase | Lives | Max Ticks | self_damage_prob | Promotion |
|-------|-------|-----------|-----------------|-----------|
| 0 | 1 | 1200 (20s) | 0.0 | 90% / 2000 eps |
| 1 | 1 | 1800 (30s) | 0.0 | 90% / 2000 eps |
| 2 | 1 | 2700 (45s) | 0.0 | 90% / 2000 eps |
| 3 | 2 | 2700 (45s) | 0.3 | 90% / 2000 eps |
| 4 | 2 | 2700 (45s) | 1.0 | 90% / 2000 eps |
| 5 | 2 | 3600 (60s) | 1.0 | 90% / 3000 eps |
| 6 | 3 | 7200 (120s) | 1.0 | Terminal |

---

## 11. Reward Weight Sweep (Optuna)

The environment gives the agent 9 different **shaping reward signals** (aim bonus, fire cost,
dodge bonus, etc.) on top of the terminal rewards (kill, win, loss). The magnitudes of these
signals dramatically affect learning — too large and they drown out the real objective, too
small and the agent ignores them. `sweep.py` uses **Optuna** to automatically search for
optimal reward weights.

### 11.1 What is Optuna?

Optuna is a Bayesian hyperparameter optimization framework. Instead of trying every
combination (grid search) or picking randomly, it builds a **probabilistic model** of which
parameter regions produce good results and focuses search there.

Key concepts:
- **Study** — a full optimization run (collection of trials)
- **Trial** — one training run with a specific set of reward weights
- **TPE Sampler** — Tree-structured Parzen Estimator. After the first few random trials, it
  models "good" vs "bad" parameter distributions and samples from the "good" region
- **Pruning** — kills underperforming trials early to save compute

### 11.2 How a Single Trial Works

Each trial runs a **short PPO training** (~500K steps, vs ~50M for full training) and
returns the **win rate** over the last 200 episodes as the objective value.

```
┌─────────────────────────────────────────────────────────────────┐
│                       SINGLE TRIAL                              │
│                                                                 │
│  1. Optuna suggests 9 reward weights (log-uniform ranges)       │
│  2. Create PhaseConfig with those weights                       │
│  3. Spin up 4 async envs with that config                       │
│  4. Train a fresh ActorCritic for 500K steps:                   │
│     ┌──────────────────────────────────┐                        │
│     │  while global_step < 500K:       │                        │
│     │    collect_rollout(2048 steps)    │                        │
│     │    compute_advantages()          │                        │
│     │    ppo_update()                  │                        │
│     │    report win_rate to Optuna     │──▶ Pruned? → stop early│
│     │  end                             │                        │
│     └──────────────────────────────────┘                        │
│  5. Return final win_rate (last 200 episodes)                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The trial reuses the same `collect_rollout()` and `ppo_update()` functions as the main
trainer — no duplicated training code.

### 11.3 The 9 Swept Reward Signals

Each signal is sampled from a range (most are log-uniform to span orders of magnitude):

| Signal | Range | Type | What It Rewards |
|--------|-------|------|-----------------|
| `bfs_follow` | [0.005, 0.05] | log | Moving toward opponent via BFS path |
| `fire_cost_abs` | [0.02, 0.3] | log | Penalty per shot fired (prevents spam) |
| `good_aim` | [0.02, 0.3] | linear | Firing with line-of-sight to opponent |
| `bullet_near_opp` | [0.1, 1.0] | linear | Bullet passing within 50px of opponent |
| `time_penalty_abs` | [0.0005, 0.01] | log | Per-tick time pressure |
| `dodge_near_miss` | [0.02, 0.3] | linear | Dodging opponent bullets |
| `dodge_self_bullet` | [0.02, 0.3] | linear | Dodging own ricocheting bullets |
| `self_bullet_proximity_abs` | [0.005, 0.1] | log | Penalty when own bullet heading at agent |
| `stationary_penalty_abs` | [0.002, 0.05] | log | Penalty for standing still >30 ticks |

Signals with `_abs` suffix are negated (they're costs/penalties). The `log=True` ranges
mean Optuna samples uniformly in log-space — this is important because the difference
between 0.005 and 0.05 matters just as much as the difference between 0.05 and 0.5.

Terminal rewards (kill=+10, win=+10, loss=-10, etc.) are **not swept** — they stay fixed.
Only the shaping signals that guide learning behavior are optimized.

### 11.4 Pruning: Killing Bad Trials Early

The MedianPruner compares each trial's intermediate win_rate reports against the median
of completed trials:

```
Trial reports win_rate at 5 checkpoints during training:
  100K steps → 0.15
  200K steps → 0.22    ◀── If median of completed trials at 200K was 0.40,
  (PRUNED)                  this trial is clearly underperforming → kill it
```

Configuration:
- **n_startup_trials = 5** — the first 5 trials always run to completion (no median to
  compare against yet)
- **n_warmup_steps = 100K** — don't prune before the first report (agent needs time to
  learn anything)
- **5 report points** — win_rate is reported at 20%, 40%, 60%, 80%, 100% of total steps

Pruning typically saves 40-60% of total compute by killing the bottom half of trials after
just 20-40% of their allocated steps.

### 11.5 Parallel Execution

Trials are independent — each creates its own model, optimizer, and environments. Use
`--n-jobs N` to run N trials simultaneously:

```bash
# Sequential (default) — ~9 min/trial × 50 = ~7.5 hours
uv run python sweep.py --n-trials 50

# 4 parallel trials — ~7.5 hours / 4 = ~1.9 hours
uv run python sweep.py --n-trials 50 --n-jobs 4
```

When `--n-jobs > 1`, Optuna automatically uses a SQLite database (`runs/v1/sweep.db`) for
thread-safe trial coordination. This also means you can **resume** a sweep — if you kill it
and restart with the same `--study-name`, it picks up where it left off.

**GPU memory note (MPS/CUDA)**: Each parallel trial loads a separate model and runs its own
async envs. With `--n-jobs 4` and `--num-envs 4`, that's 4 models + 16 env processes. If
you hit OOM, reduce `--n-jobs` or `--num-envs`.

### 11.6 Reading Results

After the sweep completes, results are saved to `runs/v1/sweep_results.json`:

```json
{
  "best_trial": 23,
  "best_win_rate": 0.82,
  "best_params": {
    "bfs_follow": 0.012,
    "fire_cost_abs": 0.08,
    "good_aim": 0.19,
    ...
  }
}
```

The top-5 trials are also printed to stdout. To apply the best weights, update the
corresponding values in `phase_config.py`.

### 11.7 Why Sweep on Phase 2?

Phase 2 is the default sweep target because it uses the most shaping signals simultaneously:
- Navigation (BFS follow) — agent must pathfind through mazes
- Shooting (aim, fire cost, bullet proximity) — agent must kill opponent
- Self-bullet avoidance is off (self_damage_prob=0.0) — fewer confounding signals

Sweeping on later phases (3+) adds self-damage signals but also makes each trial slower
(longer episodes, more lives). Phase 2 gives the best signal-to-noise ratio for reward
weight tuning.

### 11.8 Usage Reference

```bash
# Basic sweep (50 trials, Phase 2, 500K steps each)
uv run python sweep.py

# Quick test sweep
uv run python sweep.py --n-trials 10 --timesteps 200000

# Parallel sweep on Phase 3
uv run python sweep.py --phase 3 --n-jobs 4 --n-trials 30

# Resume a previous sweep
uv run python sweep.py --study-name my_sweep --n-trials 20

# Distributed: run in multiple terminals sharing one DB
uv run python sweep.py --db runs/v1/sweep.db --n-trials 25 --n-jobs 2  # terminal 1
uv run python sweep.py --db runs/v1/sweep.db --n-trials 25 --n-jobs 2  # terminal 2
```

---

## Appendix A: File Map

```
training/
├─ main.py              Entry point, CLI args, env configs
├─ ppo.py               ActorCritic neural network
├─ ppo_trainer.py        Training loop, checkpoints, logging
├─ rollout_buffer.py     Experience storage + GAE computation
├─ tank_env.py           Gymnasium environment (physics, rewards, obs)
├─ phase_config.py       7-phase curriculum definitions
├─ action_table.py       Action index ↔ (movement, rotation, fire)
├─ sweep.py              Optuna reward weight optimization
└─ runs/v1/              Training artifacts
   ├─ tb_logs/           TensorBoard event files
   ├─ videos/            Recorded episode videos
   ├─ checkpoints/       Step-wise model snapshots
   ├─ ppo_tankbet-v1_latest.pt    Current weights
   ├─ ppo_tankbet-v1_best.pt      Best episode weights
   └─ ppo_training_state.pt       Full checkpoint (for --resume)
```

## Appendix B: Diagnostic Checklist

When training isn't working, check these TensorBoard metrics:

| Metric | Healthy Range | Problem If |
|--------|--------------|------------|
| entropy | Slowly decreasing, > 0.5 | Collapses to < 0.3 (premature convergence) |
| clip_fraction | 0.1 - 0.3 | > 0.5 (updates too aggressive) or ~0 (not learning) |
| explained_variance | Approaching 1.0 | Stays < 0.5 (critic not learning) |
| policy_loss | Fluctuating near 0 | Monotonically increasing (diverging) |
| value_loss | Decreasing over time | Spiking or increasing (critic unstable) |
| episode_reward | Trending upward | Plateaued or decreasing |
| win_rate | Approaching 0.9 | Stuck below 0.5 for > 1M steps |
