"""Curriculum phase configurations for TankBattle training.

Each phase defines environment rules + auto-promotion thresholds.
Reward values are uniform across all phases — only environment rules change.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PhaseConfig:
    """Single source of truth for all phase-dependent parameters."""

    # --- Environment rules (VARY per phase) ---
    max_episode_ticks: int
    opponent_can_fire: bool
    opp_fire_cooldown_ticks: int  # 0 = no limit, e.g. 180 = every 3s
    use_maze: bool  # False = open arena
    spawn_distance_fraction: tuple[float, float]  # (min, max) as fraction of arena diagonal
    opponent_stationary: bool = False  # True = opponent doesn't move
    self_damage_prob: float = 1.0  # 0.0=off, 0.3=30%, 1.0=always (agent)
    opp_self_damage: bool = True  # can opponent kill itself with own bullets?
    max_ammo_per_life: int = 999  # bullets per life; 999 = effectively unlimited
    maze_tier: str = "medium"  # "easy", "medium", "hard"

    # --- Reward values (UNIFORM across all phases) ---
    # Terminal rewards (2 signals)
    reward_kill: float = 5.0
    reward_death: float = -3.0

    # Shaping rewards (7 signals)
    reward_firing_solution_hit: float = 0.25  # fired when trace predicts hit (incl. bounces)
    reward_good_aim: float = 0.08  # well-aimed shots with LOS (supplement to firing_solution)
    reward_bfs_follow: float = 0.015  # reward for moving forward toward BFS direction
    reward_bfs_follow_cap: int = 100  # max BFS follow rewards per episode; prevents circling
    reward_wall_hit: float = -0.02  # per-tick penalty when touching a wall
    reward_idle: float = -0.003  # per-tick penalty when speed ≈ 0
    reward_wasted_shot: float = -0.025  # fired with no LOS and trace says miss
    reward_survival: float = 0.0005  # per-tick alive bonus

    # --- Auto-promotion thresholds (VARY per phase) ---
    promote_win_rate: float = 1.0  # win rate over last N episodes to advance
    promote_min_episodes: int = 999_999_999  # minimum episodes before eligible


# ──────────────────────────────────────────────────────────────────────
# Phase definitions (4 phases: 0-3)
# ──────────────────────────────────────────────────────────────────────

# Phase 0: Navigate + Shoot — Stationary opponent, unlimited ammo, easy maze
# Agent learns navigation and aiming. No threat from opponent.
_PHASE_0 = PhaseConfig(
    max_episode_ticks=30 * 60,
    opponent_can_fire=False,
    opp_fire_cooldown_ticks=0,
    use_maze=True,
    maze_tier="easy",
    spawn_distance_fraction=(0.20, 0.50),
    opponent_stationary=True,
    self_damage_prob=0.0,
    opp_self_damage=False,
    max_ammo_per_life=999,
    promote_win_rate=0.90,
    promote_min_episodes=500,
)

# Phase 1: Combat — Moving opponent fires back, opponent can't self-kill
# Agent learns dodging and combat. Wins must come from landing shots, not
# lucky opponent self-kills.
_PHASE_1 = PhaseConfig(
    max_episode_ticks=120 * 60,
    opponent_can_fire=True,
    opp_fire_cooldown_ticks=0,
    use_maze=True,
    maze_tier="hard",
    spawn_distance_fraction=(0.10, 1.0),
    self_damage_prob=1.0,
    opp_self_damage=False,
    max_ammo_per_life=999,
    promote_win_rate=0.80,
    promote_min_episodes=1000,
)

# Phase 2: Full rules — Both sides can self-kill
# Real game physics. Agent must win despite opponent also dying to own bullets.
_PHASE_2 = PhaseConfig(
    max_episode_ticks=120 * 60,
    opponent_can_fire=True,
    opp_fire_cooldown_ticks=0,
    use_maze=True,
    maze_tier="hard",
    spawn_distance_fraction=(0.10, 1.0),
    self_damage_prob=1.0,
    opp_self_damage=True,
    max_ammo_per_life=999,
    promote_win_rate=0.80,
    promote_min_episodes=1000,
)

# Phase 3: Self-Play — Terminal phase
# Opponent is a frozen copy of the agent itself, updated every N episodes.
_PHASE_3 = PhaseConfig(
    max_episode_ticks=120 * 60,
    opponent_can_fire=True,
    opp_fire_cooldown_ticks=0,
    use_maze=True,
    maze_tier="hard",
    spawn_distance_fraction=(0.10, 1.0),
    self_damage_prob=1.0,
    opp_self_damage=True,
    max_ammo_per_life=999,
    promote_win_rate=1.0,
    promote_min_episodes=999_999_999,
)

PHASE_CONFIGS: dict[int, PhaseConfig] = {
    0: _PHASE_0,
    1: _PHASE_1,
    2: _PHASE_2,
    3: _PHASE_3,
}
