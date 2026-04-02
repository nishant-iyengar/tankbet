"""Visualize BFS paths from agent to opponent across various situations.

Produces PNG images in debug_bfs_images/ showing:
- The maze walls
- Agent (green) and opponent (red) tanks
- The full BFS path as a cyan dotted line through cell centers
- The BFS direction arrow from the agent

Situations tested:
1. Adjacent cells (trivial path)
2. Same row, far apart
3. Opposite corners
4. Separated by walls requiring detour
5-10. Random spawns across different mazes
"""

import os
import math
import sys
from collections import deque
from pathlib import Path

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import gymnasium as gym
import numpy as np
import pygame
import tank_env  # registers TankBattle-v0

# Constants (must match tank_env)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tank_env import CELL_SIZE, MAZE_COLS, MAZE_ROWS, ARENA_W, ARENA_H, TANK_WIDTH, BARREL_LENGTH

OUTPUT_DIR = Path(__file__).parent / "debug_bfs_images"
OUTPUT_DIR.mkdir(exist_ok=True)


def bfs_full_path(env: tank_env.TankBattleEnv,
                  start_row: int, start_col: int,
                  goal_row: int, goal_col: int) -> list[tuple[int, int]]:
    """Return the full BFS path as a list of (row, col) cells, start to goal."""
    start = (start_row, start_col)
    goal = (goal_row, goal_col)
    if start == goal:
        return [start]

    visited: set[tuple[int, int]] = {start}
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    queue: deque[tuple[int, int]] = deque([start])

    while queue:
        r, c = queue.popleft()
        if (r, c) == goal:
            break
        for direction, dr, dc in [("up", -1, 0), ("down", 1, 0),
                                   ("left", 0, -1), ("right", 0, 1)]:
            nr, nc = r + dr, c + dc
            if (nr, nc) not in visited and env._can_move(r, c, direction):
                visited.add((nr, nc))
                parent[(nr, nc)] = (r, c)
                queue.append((nr, nc))

    if goal not in parent:
        return []  # unreachable

    # Reconstruct path from goal to start
    path = [goal]
    cell = goal
    while cell in parent:
        cell = parent[cell]
        path.append(cell)
    path.reverse()
    return path


def cell_center(row: int, col: int) -> tuple[int, int]:
    """Get pixel center of a maze cell."""
    return (col * CELL_SIZE + CELL_SIZE // 2, row * CELL_SIZE + CELL_SIZE // 2)


def render_with_bfs(env: tank_env.TankBattleEnv, title: str, filename: str) -> None:
    """Render the env state with BFS path overlay and save as PNG."""
    pygame.init()
    screen = pygame.Surface((ARENA_W, ARENA_H + 40))  # extra space for title
    screen.fill((10, 14, 26))

    # Title bar
    font = pygame.font.SysFont(None, 22)
    title_surf = font.render(title, True, (200, 200, 200))
    screen.blit(title_surf, (10, 8))

    # Offset everything down by 40px for title
    offset_y = 40

    # Draw cell grid (faint) for reference
    for r in range(MAZE_ROWS):
        for c in range(MAZE_COLS):
            cx, cy = cell_center(r, c)
            pygame.draw.circle(screen, (30, 35, 50), (cx, cy + offset_y), 2)

    # Draw walls
    for seg in env._segments:
        x1, y1, x2, y2 = seg
        pygame.draw.line(screen, (100, 116, 139),
                         (int(x1), int(y1) + offset_y),
                         (int(x2), int(y2) + offset_y), 2)

    # Compute BFS path
    ego = env._tanks[0]
    opp = env._tanks[1]
    ego_row, ego_col = int(ego["y"] // CELL_SIZE), int(ego["x"] // CELL_SIZE)
    opp_row, opp_col = int(opp["y"] // CELL_SIZE), int(opp["x"] // CELL_SIZE)

    path = bfs_full_path(env, ego_row, ego_col, opp_row, opp_col)

    # Draw BFS path as connected line through cell centers
    if len(path) >= 2:
        points = [(cell_center(r, c)[0], cell_center(r, c)[1] + offset_y)
                  for r, c in path]
        # Draw path segments as dashed cyan line
        for i in range(len(points) - 1):
            p1 = points[i]
            p2 = points[i + 1]
            pygame.draw.line(screen, (0, 200, 255), p1, p2, 2)
            # Draw small dots at cell centers along path
            pygame.draw.circle(screen, (0, 200, 255), p2, 4)
        # Highlight start cell
        pygame.draw.circle(screen, (0, 255, 100), points[0], 5)

    # Draw BFS direction arrow from agent
    if env._cached_bfs is not None:
        cos_dir, sin_dir, norm_dist = env._cached_bfs
        ax = int(ego["x"])
        ay = int(ego["y"]) + offset_y
        arrow_len = 40
        bx = ax + int(cos_dir * arrow_len)
        by = ay + int(sin_dir * arrow_len)
        pygame.draw.line(screen, (255, 255, 0), (ax, ay), (bx, by), 3)
        # Arrowhead
        angle = math.atan2(sin_dir, cos_dir)
        for da in [2.5, -2.5]:  # ~143 degrees back
            hx = bx - int(math.cos(angle + da) * 10)
            hy = by - int(math.sin(angle + da) * 10)
            pygame.draw.line(screen, (255, 255, 0), (bx, by), (hx, hy), 2)

    # Draw tanks
    colors = {0: (74, 222, 128), 1: (248, 113, 113)}
    for pid in [0, 1]:
        tank = env._tanks[pid]
        if not tank["alive"]:
            continue
        cx = int(tank["x"])
        cy = int(tank["y"]) + offset_y
        pygame.draw.circle(screen, colors[pid], (cx, cy), TANK_WIDTH // 2)
        rad = math.radians(tank["angle"])
        bx = cx + int(math.cos(rad) * BARREL_LENGTH)
        by = cy + int(math.sin(rad) * BARREL_LENGTH)
        pygame.draw.line(screen, (255, 255, 255), (cx, cy), (bx, by), 3)

        # Label
        label = font.render(f"P{pid}", True, colors[pid])
        screen.blit(label, (cx - 10, cy - TANK_WIDTH - 5))

    # Draw info text
    path_len = len(path) - 1 if path else -1
    euclidean = math.hypot(ego["x"] - opp["x"], ego["y"] - opp["y"])
    info_text = (f"BFS cells: {path_len} | "
                 f"Euclidean: {euclidean:.0f}px | "
                 f"Agent cell: ({ego_row},{ego_col}) | "
                 f"Opp cell: ({opp_row},{opp_col})")
    info_surf = font.render(info_text, True, (150, 150, 150))
    screen.blit(info_surf, (10, ARENA_H + offset_y - 25))

    # Save
    filepath = OUTPUT_DIR / filename
    pygame.image.save(screen, str(filepath))
    print(f"  Saved: {filepath} (BFS path: {path_len} cells)")


def place_tank(env: tank_env.TankBattleEnv, pid: int, row: int, col: int, angle: float = 0.0) -> None:
    """Manually place a tank at a specific cell center."""
    cx, cy = cell_center(row, col)
    env._tanks[pid]["x"] = float(cx)
    env._tanks[pid]["y"] = float(cy)
    env._tanks[pid]["angle"] = angle
    env._tanks[pid]["alive"] = True


def refresh_bfs(env: tank_env.TankBattleEnv) -> None:
    """Recompute the cached BFS for the current tank positions."""
    ego = env._tanks[0]
    opp = env._tanks[1]
    ego_col = int(ego["x"] // CELL_SIZE)
    ego_row = int(ego["y"] // CELL_SIZE)
    opp_col = int(opp["x"] // CELL_SIZE)
    opp_row = int(opp["y"] // CELL_SIZE)
    env._cached_bfs = env._bfs_path_direction(ego_row, ego_col, opp_row, opp_col)


def main() -> None:
    print(f"Generating BFS debug images in {OUTPUT_DIR}/\n")

    # Use Phase 1 (has maze)
    env = gym.make("TankBattle-v0", training_phase=1, render_mode="rgb_array")
    env = env.unwrapped

    # ── Situation 1: Adjacent cells ──
    print("Situation 1: Adjacent cells")
    env.reset()
    place_tank(env, 0, 2, 3, angle=0)
    place_tank(env, 1, 2, 4, angle=180)
    refresh_bfs(env)
    render_with_bfs(env, "1: Adjacent cells (trivial 1-cell path)", "01_adjacent.png")

    # ── Situation 2: Same row, far apart ──
    print("Situation 2: Same row, far apart")
    env.reset()
    place_tank(env, 0, 3, 0, angle=0)
    place_tank(env, 1, 3, 8, angle=180)
    refresh_bfs(env)
    render_with_bfs(env, "2: Same row, opposite sides", "02_same_row_far.png")

    # ── Situation 3: Opposite corners ──
    print("Situation 3: Opposite corners")
    env.reset()
    place_tank(env, 0, 0, 0, angle=0)
    place_tank(env, 1, 5, 8, angle=180)
    refresh_bfs(env)
    render_with_bfs(env, "3: Opposite corners (max distance)", "03_opposite_corners.png")

    # ── Situation 4: Same cell ──
    print("Situation 4: Same cell")
    env.reset()
    place_tank(env, 0, 2, 4, angle=45)
    place_tank(env, 1, 2, 4, angle=225)
    refresh_bfs(env)
    render_with_bfs(env, "4: Same cell (zero path)", "04_same_cell.png")

    # ── Situation 5: Vertically adjacent ──
    print("Situation 5: Vertically adjacent")
    env.reset()
    place_tank(env, 0, 1, 4, angle=90)
    place_tank(env, 1, 4, 4, angle=270)
    refresh_bfs(env)
    render_with_bfs(env, "5: Same column, vertical distance", "05_vertical.png")

    # ── Situations 6-15: Random spawns on different mazes ──
    for i in range(10):
        print(f"Situation {i + 6}: Random maze + spawn #{i + 1}")
        env.reset()  # new maze, new spawns
        refresh_bfs(env)
        render_with_bfs(env, f"{i + 6}: Random maze & spawn #{i + 1}",
                        f"{i + 6:02d}_random_{i + 1}.png")

    env.close()
    print(f"\nDone! {len(list(OUTPUT_DIR.glob('*.png')))} images saved to {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
