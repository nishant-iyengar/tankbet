"""Debug: trace the full BFS path for the corner scenario and visualize it."""
import math
import sys
import os
from collections import deque

sys.path.insert(0, os.path.dirname(__file__))

import tank_env
from tank_env import CELL_SIZE, MAZE_ROWS, MAZE_COLS, BFS_SUB_GRID

def cell_center(row: int, col: int) -> tuple[float, float]:
    return col * CELL_SIZE + CELL_SIZE / 2, row * CELL_SIZE + CELL_SIZE / 2


def trace_bfs_path(env: tank_env.TankBattleEnv) -> None:
    ego = env._tanks[0]
    opp = env._tanks[1]
    ego_x, ego_y = ego["x"], ego["y"]
    opp_x, opp_y = opp["x"], opp["y"]

    sub_size = CELL_SIZE / BFS_SUB_GRID
    total_sr = MAZE_ROWS * BFS_SUB_GRID
    total_sc = MAZE_COLS * BFS_SUB_GRID

    ego_sr = min(max(int(ego_y / sub_size), 0), total_sr - 1)
    ego_sc = min(max(int(ego_x / sub_size), 0), total_sc - 1)
    opp_sr = min(max(int(opp_y / sub_size), 0), total_sr - 1)
    opp_sc = min(max(int(opp_x / sub_size), 0), total_sc - 1)

    print(f"Ego pixel: ({ego_x}, {ego_y}) → sub-cell ({ego_sr}, {ego_sc}) → maze cell ({ego_sr//BFS_SUB_GRID}, {ego_sc//BFS_SUB_GRID})")
    print(f"Opp pixel: ({opp_x}, {opp_y}) → sub-cell ({opp_sr}, {opp_sc}) → maze cell ({opp_sr//BFS_SUB_GRID}, {opp_sc//BFS_SUB_GRID})")

    # Run BFS and record full path
    start = (ego_sr, ego_sc)
    goal = (opp_sr, opp_sc)
    visited = {start}
    parent = {}
    queue = deque([start])

    while queue:
        sr, sc = queue.popleft()
        if (sr, sc) == goal:
            break
        for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nsr, nsc = sr + dr, sc + dc
            if nsr < 0 or nsr >= total_sr or nsc < 0 or nsc >= total_sc:
                continue
            if (nsr, nsc) in visited:
                continue
            maze_r1 = sr // BFS_SUB_GRID
            maze_c1 = sc // BFS_SUB_GRID
            maze_r2 = nsr // BFS_SUB_GRID
            maze_c2 = nsc // BFS_SUB_GRID
            if maze_r1 != maze_r2 or maze_c1 != maze_c2:
                if dr == -1 and not env._can_move(maze_r1, maze_c1, "up"):
                    continue
                if dr == 1 and not env._can_move(maze_r1, maze_c1, "down"):
                    continue
                if dc == -1 and not env._can_move(maze_r1, maze_c1, "left"):
                    continue
                if dc == 1 and not env._can_move(maze_r1, maze_c1, "right"):
                    continue
            visited.add((nsr, nsc))
            parent[(nsr, nsc)] = (sr, sc)
            queue.append((nsr, nsc))

    if goal not in parent:
        print("NO PATH FOUND!")
        return

    # Reconstruct full path
    path = [goal]
    cell = goal
    while cell in parent:
        cell = parent[cell]
        path.append(cell)
    path.reverse()

    print(f"\nFull BFS path ({len(path)} steps):")
    print(f"  Start: sub ({path[0][0]}, {path[0][1]}) = maze ({path[0][0]//BFS_SUB_GRID}, {path[0][1]//BFS_SUB_GRID})")
    for i, (sr, sc) in enumerate(path[1:], 1):
        mr, mc = sr // BFS_SUB_GRID, sc // BFS_SUB_GRID
        if i <= 5 or i >= len(path) - 3:
            print(f"  Step {i}: sub ({sr}, {sc}) = maze ({mr}, {mc})")
        elif i == 6:
            print(f"  ... ({len(path) - 8} steps omitted) ...")

    # First step direction
    next_sr, next_sc = path[1]
    target_x = next_sc * sub_size + sub_size / 2
    target_y = next_sr * sub_size + sub_size / 2
    dx = target_x - ego_x
    dy = target_y - ego_y
    world_angle_deg = math.degrees(math.atan2(dy, dx))
    print(f"\nFirst step: sub ({next_sr}, {next_sc})")
    print(f"  Target pixel: ({target_x}, {target_y})")
    print(f"  Delta: dx={dx:.1f}, dy={dy:.1f}")
    print(f"  World angle: {world_angle_deg:.1f}°")
    print(f"  (0°=right, 90°=down, -90°=up, 180°=left)")

    # Also show what _can_move says for ego's maze cell in each direction
    ego_mr = ego_sr // BFS_SUB_GRID
    ego_mc = ego_sc // BFS_SUB_GRID
    print(f"\nWall check from ego maze cell ({ego_mr}, {ego_mc}):")
    for d in ["up", "down", "left", "right"]:
        can = env._can_move(ego_mr, ego_mc, d)
        print(f"  {d:6s}: {'OPEN' if can else 'BLOCKED'}")

    # Show walls for nearby cells
    print(f"\nWall lookup for nearby cells:")
    for r in range(max(0, ego_mr - 2), min(MAZE_ROWS, ego_mr + 3)):
        for c in range(max(0, ego_mc - 2), min(MAZE_COLS, ego_mc + 3)):
            top = env._has_wall(r, c, "top")
            right = env._has_wall(r, c, "right")
            marker = " <-- EGO" if (r, c) == (ego_mr, ego_mc) else ""
            marker = " <-- OPP" if (r, c) == (opp_sr // BFS_SUB_GRID, opp_sc // BFS_SUB_GRID) else marker
            print(f"  ({r},{c}): top={'W' if top else '.'} right={'W' if right else '.'}{marker}")


def main() -> None:
    env = tank_env.TankBattleEnv(training_phase=0)
    env.reset()
    raw = env.unwrapped

    # Place tanks exactly as in scenario 2
    cx0, cy0 = cell_center(3, 2)
    raw._tanks[0]["x"] = float(cx0)
    raw._tanks[0]["y"] = float(cy0)
    raw._tanks[0]["angle"] = 315.0
    raw._tanks[0]["alive"] = True
    raw._tanks[0]["speed"] = 0.0

    cx1, cy1 = cell_center(1, 4)
    raw._tanks[1]["x"] = float(cx1)
    raw._tanks[1]["y"] = float(cy1)
    raw._tanks[1]["angle"] = 180.0
    raw._tanks[1]["alive"] = True
    raw._tanks[1]["speed"] = 0.0

    trace_bfs_path(raw)

    # Also check what the env returns
    result = raw._bfs_path_direction(raw._tanks[0]["x"], raw._tanks[0]["y"],
                                      raw._tanks[1]["x"], raw._tanks[1]["y"])
    print(f"\n_bfs_path_direction result: cos={result[0]:.4f}, sin={result[1]:.4f}, dist={result[2]:.4f}")

    ego_rad = math.radians(315)
    cos_e = math.cos(ego_rad)
    sin_e = math.sin(ego_rad)
    rel_cos = result[0] * cos_e + result[1] * sin_e
    rel_sin = -result[0] * sin_e + result[1] * cos_e
    print(f"In ego frame: cos={rel_cos:.4f}, sin={rel_sin:.4f}")


if __name__ == "__main__":
    main()
