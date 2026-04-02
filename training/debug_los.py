"""Debug LOS: verify line-of-sight calculations against maze geometry.

Usage:
    cd training && uv run python debug_los.py
"""

import json
import math
from pathlib import Path

import gymnasium
import numpy as np

import tank_env  # noqa: F401
from tank_env import CELL_SIZE, MAZE_COLS, MAZE_ROWS, ARENA_W, ARENA_H


def main() -> None:
    # Use phase 1 (maze) for LOS testing — phase 0 has no internal walls
    env = gymnasium.make("TankBattle-v0", training_phase=1, render_mode=None)
    unwrapped = env.unwrapped

    # Obs indices for new 123-dim layout
    LOS_HAS_IDX = 106
    LOS_DIST_IDX = 107
    OPP_ALIVE_IDX = 12

    for episode in range(5):
        obs, info = env.reset()
        ego = unwrapped._tanks[0]
        opp = unwrapped._tanks[1]

        print(f"\n{'='*60}")
        print(f"Episode {episode + 1}")
        print(f"Ego: ({ego['x']:.1f}, {ego['y']:.1f}) angle={ego['angle']:.1f}")
        print(f"Opp: ({opp['x']:.1f}, {opp['y']:.1f}) angle={opp['angle']:.1f}")
        print(f"Distance: {math.hypot(ego['x']-opp['x'], ego['y']-opp['y']):.1f}px")

        # Check LOS
        has_wall = unwrapped._line_segment_crosses_any_wall(
            ego["x"], ego["y"], opp["x"], opp["y"]
        )
        print(f"LOS blocked by wall: {has_wall}")
        print(f"Obs has_los: {obs[LOS_HAS_IDX]:.1f}, obs los_distance: {obs[LOS_DIST_IDX]:.4f}")

        # Verify consistency
        if has_wall:
            assert obs[LOS_HAS_IDX] == 0.0, f"LOS obs says has_los=1 but wall blocks it!"
            assert obs[LOS_DIST_IDX] == 0.0, f"LOS distance should be 0 when blocked"
        else:
            assert obs[LOS_HAS_IDX] == 1.0, f"LOS obs says has_los=0 but no wall blocks it!"
            expected_dist = math.hypot(opp["x"] - ego["x"], opp["y"] - ego["y"]) / math.hypot(ARENA_W, ARENA_H)
            assert abs(obs[LOS_DIST_IDX] - expected_dist) < 0.01, (
                f"LOS distance mismatch: obs={obs[LOS_DIST_IDX]:.4f}, expected={expected_dist:.4f}"
            )
        print("  LOS obs CONSISTENT with wall check ✓")

        # Count how many walls are between ego and opp
        wall_count = 0
        for seg in unwrapped._segments:
            if unwrapped._segments_intersect(
                ego["x"], ego["y"], opp["x"], opp["y"],
                seg[0], seg[1], seg[2], seg[3],
            ):
                wall_count += 1
        print(f"  Walls crossed by LOS line: {wall_count}")

        # Now walk toward opponent and check LOS changes
        print("\n  Walking 100 steps, tracking LOS changes:")
        prev_los = obs[LOS_HAS_IDX]
        los_changes = 0
        for step in range(100):
            # Always move forward
            obs, reward, terminated, truncated, info = env.step(1)  # up
            curr_los = obs[LOS_HAS_IDX]
            if curr_los != prev_los:
                los_changes += 1
                ego = unwrapped._tanks[0]
                opp = unwrapped._tanks[1]
                dist = math.hypot(ego["x"] - opp["x"], ego["y"] - opp["y"])
                print(f"    Step {step+1}: LOS {'gained' if curr_los == 1.0 else 'lost'} "
                      f"(ego=({ego['x']:.0f},{ego['y']:.0f}) dist={dist:.0f}px)")
                # Verify
                has_wall = unwrapped._line_segment_crosses_any_wall(
                    ego["x"], ego["y"], opp["x"], opp["y"]
                )
                expected_los = 0.0 if has_wall else 1.0
                assert curr_los == expected_los, (
                    f"LOS MISMATCH at step {step+1}: obs={curr_los}, wall_check={has_wall}"
                )
            prev_los = curr_los
            if terminated or truncated:
                print(f"    Episode ended at step {step+1}")
                break
        print(f"  Total LOS changes: {los_changes}")

    env.close()
    print("\n\nAll LOS checks PASSED ✓")


if __name__ == "__main__":
    main()
