"""Debug script: run a few episodes and log observation state + rewards to a file.

Usage:
    cd training && uv run python debug_obs.py

Outputs to: training/debug_obs.log
"""

import json
import math
import sys
from pathlib import Path

import gymnasium
import numpy as np

# Register env
import tank_env  # noqa: F401
from tank_env import OBS_DIM, BULLET_OBS_SLOTS

LOG_FILE = Path(__file__).parent / "debug_obs.log"
LOG_EVERY_N_STEPS = 5  # log every N agent decision steps
NUM_EPISODES = 3
MAX_STEPS = 200  # per episode

# Observation layout (123 values total)
OBS_LABELS: list[tuple[str, int, int]] = [
    ("Ego tank", 0, 7),
    ("  ego_x_norm", 0, 1),
    ("  ego_y_norm", 1, 1),
    ("  ego_cos_angle", 2, 1),
    ("  ego_sin_angle", 3, 1),
    ("  ego_speed_norm", 4, 1),
    ("  ego_alive", 5, 1),
    ("  ego_can_fire", 6, 1),
    ("Opponent (ego-centric)", 7, 8),
    ("  opp_rel_x_ego", 7, 1),
    ("  opp_rel_y_ego", 8, 1),
    ("  opp_rel_cos_angle", 9, 1),
    ("  opp_rel_sin_angle", 10, 1),
    ("  opp_speed_norm", 11, 1),
    ("  opp_alive", 12, 1),
    ("  bearing_cos", 13, 1),
    ("  bearing_sin", 14, 1),
    ("Lives", 15, 2),
    ("  ego_lives", 15, 1),
    ("  opp_lives", 16, 1),
    (f"Bullets ({BULLET_OBS_SLOTS} slots x 6)", 17, BULLET_OBS_SLOTS * 6),
    ("Local wall grid (5x5 x 2)", 17 + BULLET_OBS_SLOTS * 6, 50),
    ("Metadata", 103, 3),
    ("  time_progress", 103, 1),
    ("  ego_bullets_norm", 104, 1),
    ("  opp_bullets_norm", 105, 1),
    ("LOS to opponent", 106, 2),
    ("  has_los", 106, 1),
    ("  los_distance", 107, 1),
    ("Wall raycasts (12 dirs)", 108, 12),
    ("BFS compass", 120, 3),
    ("  bfs_rel_cos", 120, 1),
    ("  bfs_rel_sin", 121, 1),
    ("  bfs_path_dist", 122, 1),
]


def format_obs(obs: np.ndarray) -> str:
    """Format observation vector with labels."""
    lines = []
    for label, start, count in OBS_LABELS:
        if count == 1:
            lines.append(f"  {label}: {obs[start]:.4f}")
        elif count <= 12:
            vals = [f"{obs[start + i]:.4f}" for i in range(count)]
            lines.append(f"  {label}: [{', '.join(vals)}]")
        else:
            # Summarize large sections
            section = obs[start : start + count]
            nonzero = np.count_nonzero(section)
            lines.append(
                f"  {label}: {count} values, {nonzero} nonzero, "
                f"min={section.min():.4f}, max={section.max():.4f}"
            )
    return "\n".join(lines)


def count_active_bullets(obs: np.ndarray) -> int:
    """Count how many bullet slots have nonzero data."""
    count = 0
    for i in range(BULLET_OBS_SLOTS):
        slot = obs[17 + i * 6 : 17 + (i + 1) * 6]
        if np.any(slot != 0):
            count += 1
    return count


def format_bullet_details(obs: np.ndarray) -> str:
    """Show details of active bullets."""
    lines = []
    for i in range(BULLET_OBS_SLOTS):
        base = 17 + i * 6
        slot = obs[base : base + 6]
        if np.any(slot != 0):
            owner = "ego" if slot[4] == 1.0 else "opp"
            heading = "toward" if slot[5] > 0 else "away"
            lines.append(
                f"    bullet[{i}]: rel_pos=({slot[0]:.3f},{slot[1]:.3f}) "
                f"vel=({slot[2]:.3f},{slot[3]:.3f}) owner={owner} {heading}({slot[5]:.2f})"
            )
    return "\n".join(lines) if lines else "    (none)"


def validate_obs(obs: np.ndarray, step: int) -> list[str]:
    """Check for anomalies in the observation."""
    issues = []

    # Check bounds
    if obs.min() < -1.01 or obs.max() > 1.01:
        issues.append(f"OUT OF BOUNDS: min={obs.min():.4f}, max={obs.max():.4f}")

    # Check shape
    if obs.shape != (OBS_DIM,):
        issues.append(f"WRONG SHAPE: expected ({OBS_DIM},), got {obs.shape}")

    # Ego should be alive
    if obs[5] < 0.5:
        issues.append("ego is dead")

    # Opp should be alive (usually)
    if obs[12] < 0.5:
        issues.append("opponent is dead")

    # Lives should be > 0
    if obs[15] <= 0:
        issues.append("ego lives = 0")
    if obs[16] <= 0:
        issues.append("opp lives = 0")

    # BFS compass: if opp alive and using maze, should have nonzero direction
    if obs[12] > 0.5:  # opp alive
        bfs_mag = math.hypot(obs[120], obs[121])
        # BFS might be zero in open arena (Phase 0) — only flag if path_dist > 0
        if obs[122] > 0 and bfs_mag < 0.01:
            issues.append(f"BFS direction magnitude near zero ({bfs_mag:.4f}) despite opp alive and path_dist > 0")

    # Cos/sin pairs should have magnitude ~1
    for name, ci, si in [
        ("ego_angle", 2, 3),
        ("opp_rel_angle", 9, 10),
        ("bearing", 13, 14),
    ]:
        mag = math.hypot(obs[ci], obs[si])
        if abs(mag - 1.0) > 0.05:
            issues.append(f"{name} cos/sin magnitude = {mag:.4f} (expected ~1.0)")

    return issues


def main() -> None:
    # Use phase 1 (maze) for most interesting observations; use phase 0 for open arena
    import sys
    phase = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    env = gymnasium.make("TankBattle-v0", training_phase=phase, render_mode=None)
    log_lines: list[str] = []

    def log(msg: str) -> None:
        print(msg)
        log_lines.append(msg)

    log("=" * 70)
    log("OBSERVATION STATE DEBUG LOG")
    log(f"Obs space shape: {env.observation_space.shape}")
    log(f"Expected OBS_DIM: {OBS_DIM}")
    log(f"Action space: {env.action_space}")
    log(f"Phase: {phase}")
    log("=" * 70)

    from action_table import ACTION_TABLE, decode_action

    for ep in range(NUM_EPISODES):
        obs, info = env.reset()
        log(f"\n{'='*70}")
        log(f"EPISODE {ep + 1}")
        log(f"{'='*70}")
        log(f"\nInitial observation:")
        log(format_obs(obs))
        issues = validate_obs(obs, 0)
        if issues:
            log(f"  *** ISSUES: {issues}")

        total_reward = 0.0
        for step in range(MAX_STEPS):
            action = env.action_space.sample()
            obs, reward, terminated, truncated, info = env.step(action)
            total_reward += reward

            if (step + 1) % LOG_EVERY_N_STEPS == 0:
                action_bits = decode_action(action)
                log(f"\n--- Step {step + 1} | action={action} ({action_bits}) | reward={reward:.4f} | total={total_reward:.4f} ---")
                log(format_obs(obs))
                n_bullets = count_active_bullets(obs)
                if n_bullets > 0:
                    log(f"  Active bullets ({n_bullets}):")
                    log(format_bullet_details(obs))
                issues = validate_obs(obs, step + 1)
                if issues:
                    log(f"  *** ISSUES: {issues}")

            if terminated or truncated:
                log(f"\n--- Episode ended at step {step + 1} | terminated={terminated} truncated={truncated} ---")
                log(f"Final reward: {total_reward:.4f}")
                break

    env.close()

    # Write log file
    with open(LOG_FILE, "w") as f:
        f.write("\n".join(log_lines))
    print(f"\nLog written to {LOG_FILE}")


if __name__ == "__main__":
    main()
