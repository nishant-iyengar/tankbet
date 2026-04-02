"""Visualize EVERY observation dimension overlaid on the game render.

Generates one PNG per logical signal (cos/sin pairs share an image).
Each image shows:
  - Game state (maze, tanks, bullets) on the left
  - Visual overlay specific to that signal (arrows, lines, highlights)
  - Text panel on the right with dim index, name, raw value, and verification

Usage:
    cd training && uv run python debug_obs_visual.py
"""

import math
import os
from pathlib import Path
from typing import Any

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import gymnasium as gym
import numpy as np
import pygame
import tank_env  # noqa: F401

from tank_env import (
    ARENA_H,
    ARENA_W,
    BARREL_LENGTH,
    BFS_SUB_GRID,
    BULLET_LIFETIME,
    BULLET_OBS_SLOTS,
    BULLET_SPEED,
    CELL_SIZE,
    FIRE_COOLDOWN_TICKS,
    MAX_BULLETS,
    MAZE_COLS,
    MAZE_ROWS,
    OBS_DIM,
    TANK_SPEED,
    TANK_WIDTH,
    WALL_GRID_RADIUS,
)

OUTPUT_DIR = Path(__file__).parent / "debug_obs_visual"
OUTPUT_DIR.mkdir(exist_ok=True)

# Global scenario prefix — set before calling gen_* functions
_scenario_prefix: str = ""

PANEL_W = 420
IMG_W = ARENA_W + PANEL_W
IMG_H = ARENA_H + 40  # game + title bar

# Observation index mapping for the CURRENT 147-dim layout.
# Lives were removed, so bullets start at 15 (not 17).
# fmt: off
IDX = {
    # Ego [0..6]
    "ego_x":         0,
    "ego_y":         1,
    "ego_cos":       2,
    "ego_sin":       3,
    "ego_speed":     4,
    "ego_alive":     5,
    "ego_can_fire":  6,
    # Opponent [7..14]
    "opp_rel_x":     7,
    "opp_rel_y":     8,
    "opp_rel_cos":   9,
    "opp_rel_sin":  10,
    "opp_speed":    11,
    "opp_alive":    12,
    "opp_bear_cos": 13,
    "opp_bear_sin": 14,
    # Bullets [15..50]
    "bullets":      15,
    # Wall grid [51..100]
    "wall_grid":    51,
    # Metadata [101..103]
    "time_ratio":  101,
    "ego_bullets": 102,
    "opp_bullets": 103,
    # LOS [104..105]
    "has_los":     104,
    "los_dist":    105,
    # Raycasts [106..117]
    "raycasts":    106,
    # BFS compass [118..120]
    "bfs_cos":     118,
    "bfs_sin":     119,
    "bfs_dist":    120,
    # BFS quadrant [121..124]
    "bfs_quad":    121,
    # Aim [125..126]
    "aim_cos":     125,
    "aim_sin":     126,
    # Lead [127..129]
    "lead_cos":    127,
    "lead_sin":    128,
    "lead_err":    129,
    # Shot difficulty [130..131]
    "angular_w":   130,
    "tti":         131,
    # Threat [132..135]
    "threat_count":132,
    "threat_dist": 133,
    "threat_cos":  134,
    "threat_sin":  135,
    # Self-threat [136..139]
    "self_count":  136,
    "self_dist":   137,
    "self_cos":    138,
    "self_sin":    139,
    # Tactical [140..141]
    "fire_cd":     140,
    "opp_facing":  141,
    # Barrel wall [142]
    "barrel_wall": 142,
    # Firing solution [143..145]
    "fs_hit":      143,
    "fs_dist":     144,
    "fs_self":     145,
    # Ammo [146]
    "ammo":        146,
}
# fmt: on


# ═══════════════════════════════════════════════════════════════════
# Drawing helpers
# ═══════════════════════════════════════════════════════════════════

def _init_pygame() -> tuple[pygame.font.Font, pygame.font.Font, pygame.font.Font]:
    pygame.init()
    return (
        pygame.font.SysFont("monospace", 14),
        pygame.font.SysFont("monospace", 12),
        pygame.font.SysFont("monospace", 18),
    )


FONT, FONT_SM, FONT_LG = _init_pygame()

GREEN = (74, 222, 128)
RED = (248, 113, 113)
CYAN = (0, 200, 255)
YELLOW = (255, 220, 80)
MAGENTA = (255, 0, 255)
WHITE = (255, 255, 255)
GRAY = (140, 140, 140)
ORANGE = (255, 165, 0)
DIM_GRAY = (60, 60, 80)


def cell_center(row: int, col: int) -> tuple[float, float]:
    return (col * CELL_SIZE + CELL_SIZE / 2, row * CELL_SIZE + CELL_SIZE / 2)


def draw_arrow(surf: pygame.Surface, color: tuple[int, int, int],
               start: tuple[int, int], end: tuple[int, int], width: int = 2) -> None:
    pygame.draw.line(surf, color, start, end, width)
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    if length < 3:
        return
    angle = math.atan2(dy, dx)
    for da in [2.5, -2.5]:
        hx = end[0] - int(math.cos(angle + da) * 10)
        hy = end[1] - int(math.sin(angle + da) * 10)
        pygame.draw.line(surf, color, end, (hx, hy), width)


def draw_dashed(surf: pygame.Surface, color: tuple[int, int, int],
                start: tuple[int, int], end: tuple[int, int],
                width: int = 1, dash: int = 8) -> None:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    if length < 1:
        return
    n = max(int(length / dash), 1)
    for i in range(0, n, 2):
        t1 = i / n
        t2 = min((i + 1) / n, 1.0)
        p1 = (int(start[0] + dx * t1), int(start[1] + dy * t1))
        p2 = (int(start[0] + dx * t2), int(start[1] + dy * t2))
        pygame.draw.line(surf, color, p1, p2, width)


def make_base_image(env: tank_env.TankBattleEnv, title: str) -> pygame.Surface:
    """Render the game state: maze, walls, tanks, bullets."""
    surf = pygame.Surface((IMG_W, IMG_H))
    surf.fill((10, 14, 26))
    oy = 30  # title bar offset

    # Title
    surf.blit(FONT_LG.render(title, True, CYAN), (10, 6))

    # Cell grid dots
    for r in range(MAZE_ROWS):
        for c in range(MAZE_COLS):
            cx, cy = cell_center(r, c)
            pygame.draw.circle(surf, (30, 35, 50), (int(cx), int(cy) + oy), 2)

    # Walls
    for seg in env._segments:
        x1, y1, x2, y2 = seg
        pygame.draw.line(surf, (100, 116, 139),
                         (int(x1), int(y1) + oy), (int(x2), int(y2) + oy), 2)

    # Bullets
    for b in env._bullets:
        color = GREEN if b["owner"] == 0 else RED
        bx, by = int(b["x"]), int(b["y"]) + oy
        pygame.draw.circle(surf, color, (bx, by), 4)
        # Velocity arrow
        vscale = 15 / BULLET_SPEED
        vex = bx + int(b["vx"] * vscale)
        vey = by + int(b["vy"] * vscale)
        pygame.draw.line(surf, color, (bx, by), (vex, vey), 1)

    # Tanks
    tank_colors = {0: GREEN, 1: RED}
    for pid in [0, 1]:
        tank = env._tanks[pid]
        if not tank["alive"]:
            continue
        cx = int(tank["x"])
        cy = int(tank["y"]) + oy
        pygame.draw.circle(surf, tank_colors[pid], (cx, cy), TANK_WIDTH // 2)
        rad = math.radians(tank["angle"])
        bx = cx + int(math.cos(rad) * BARREL_LENGTH)
        by = cy + int(math.sin(rad) * BARREL_LENGTH)
        pygame.draw.line(surf, WHITE, (cx, cy), (bx, by), 3)
        label = "EGO" if pid == 0 else "OPP"
        surf.blit(FONT_SM.render(label, True, tank_colors[pid]),
                  (cx - 12, cy - TANK_WIDTH - 8))

    return surf


def add_text_panel(surf: pygame.Surface, lines: list[tuple[str, tuple[int, int, int]]]) -> None:
    """Draw text lines on the right panel."""
    x = ARENA_W + 10
    y = 35
    for text, color in lines:
        surf.blit(FONT_SM.render(text, True, color), (x, y))
        y += 15


def save(surf: pygame.Surface, filename: str) -> None:
    if _scenario_prefix:
        name, ext = os.path.splitext(filename)
        filename = f"{_scenario_prefix}_{name}{ext}"
    path = OUTPUT_DIR / filename
    pygame.image.save(surf, str(path))
    print(f"  {filename}")


def ego_xy(env: tank_env.TankBattleEnv) -> tuple[int, int]:
    return int(env._tanks[0]["x"]), int(env._tanks[0]["y"]) + 30


def opp_xy(env: tank_env.TankBattleEnv) -> tuple[int, int]:
    return int(env._tanks[1]["x"]), int(env._tanks[1]["y"]) + 30


# ═══════════════════════════════════════════════════════════════════
# Per-signal image generators
# ═══════════════════════════════════════════════════════════════════

def gen_ego_position(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [0..1]: ego_x, ego_y — absolute position, normalized."""
    surf = make_base_image(env, "[0..1] Ego Position (x, y)")
    ex, ey = ego_xy(env)
    # Crosshairs
    pygame.draw.line(surf, YELLOW, (ex, 30), (ex, ARENA_H + 30), 1)
    pygame.draw.line(surf, YELLOW, (0, ey), (ARENA_W, ey), 1)
    add_text_panel(surf, [
        (f"[0] ego_x = {obs[0]:.4f}", WHITE),
        (f"    = ego_x_px / ARENA_W", GRAY),
        (f"    = {env._tanks[0]['x']:.1f} / {ARENA_W} = {env._tanks[0]['x']/ARENA_W:.4f}", CYAN),
        (f"", WHITE),
        (f"[1] ego_y = {obs[1]:.4f}", WHITE),
        (f"    = ego_y_px / ARENA_H", GRAY),
        (f"    = {env._tanks[0]['y']:.1f} / {ARENA_H} = {env._tanks[0]['y']/ARENA_H:.4f}", CYAN),
        (f"", WHITE),
        (f"Pixel position: ({env._tanks[0]['x']:.0f}, {env._tanks[0]['y']:.0f})", YELLOW),
    ])
    save(surf, "dim_00_01_ego_position.png")


def gen_ego_angle(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [2..3]: cos/sin of ego heading."""
    surf = make_base_image(env, "[2..3] Ego Angle (cos, sin)")
    ex, ey = ego_xy(env)
    # Direction arrow
    angle_rad = math.atan2(obs[3], obs[2])
    arrow_len = 80
    ax = ex + int(math.cos(angle_rad) * arrow_len)
    ay = ey + int(math.sin(angle_rad) * arrow_len)
    draw_arrow(surf, YELLOW, (ex, ey), (ax, ay), 3)

    actual_angle = env._tanks[0]["angle"]
    computed_angle = math.degrees(angle_rad)
    match = abs((actual_angle % 360) - (computed_angle % 360)) < 1.0
    add_text_panel(surf, [
        (f"[2] cos(angle) = {obs[2]:.4f}", WHITE),
        (f"[3] sin(angle) = {obs[3]:.4f}", WHITE),
        (f"", WHITE),
        (f"Computed angle: {computed_angle:.1f}°", CYAN),
        (f"Actual angle:   {actual_angle:.1f}°", CYAN),
        (f"Match: {'YES' if match else 'NO'}", GREEN if match else RED),
        (f"", WHITE),
        (f"Yellow arrow = facing direction", YELLOW),
    ])
    save(surf, "dim_02_03_ego_angle.png")


def gen_ego_speed(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dim [4]: ego speed, normalized."""
    surf = make_base_image(env, "[4] Ego Speed")
    ex, ey = ego_xy(env)
    speed_px = obs[4] * TANK_SPEED
    if abs(speed_px) > 0.1:
        rad = math.radians(env._tanks[0]["angle"])
        mx = ex + int(math.cos(rad) * speed_px * 0.3)
        my = ey + int(math.sin(rad) * speed_px * 0.3)
        draw_arrow(surf, YELLOW, (ex, ey), (mx, my), 3)
    add_text_panel(surf, [
        (f"[4] speed = {obs[4]:.4f}", WHITE),
        (f"    = tank_speed / TANK_SPEED", GRAY),
        (f"    = {env._tanks[0]['speed']:.1f} / {TANK_SPEED}", CYAN),
        (f"", WHITE),
        (f"+1 = full forward ({TANK_SPEED} px/s)", GRAY),
        (f" 0 = stopped", GRAY),
        (f"-0.85 = full reverse", GRAY),
    ])
    save(surf, "dim_04_ego_speed.png")


def gen_ego_alive_canfire(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [5..6]: alive flag, can_fire flag."""
    surf = make_base_image(env, "[5..6] Alive & Can Fire")
    add_text_panel(surf, [
        (f"[5] alive    = {obs[5]:.1f}  ({'YES' if obs[5] > 0.5 else 'NO'})",
         GREEN if obs[5] > 0.5 else RED),
        (f"    always 1.0 (episode ends on death)", GRAY),
        (f"", WHITE),
        (f"[6] can_fire = {obs[6]:.1f}  ({'YES' if obs[6] > 0.5 else 'NO'})",
         GREEN if obs[6] > 0.5 else RED),
        (f"    checks: cooldown elapsed ({FIRE_COOLDOWN_TICKS} ticks)", GRAY),
        (f"            + bullets < {MAX_BULLETS}", GRAY),
        (f"            + ammo > 0", GRAY),
    ])
    save(surf, "dim_05_06_alive_canfire.png")


def gen_opp_position(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [7..8]: opponent relative position in ego frame."""
    surf = make_base_image(env, "[7..8] Opponent Relative Position (ego frame)")
    ex, ey = ego_xy(env)
    ox, oy_pos = opp_xy(env)

    # Draw world-frame vector (orange dashed)
    draw_dashed(surf, ORANGE, (ex, ey), (ox, oy_pos), 2)

    # Draw ego-frame axes
    ego_rad = math.radians(env._tanks[0]["angle"])
    cos_e = math.cos(ego_rad)
    sin_e = math.sin(ego_rad)
    axis_len = 50
    # Forward axis (ego +x)
    draw_arrow(surf, (100, 255, 100),
               (ex, ey),
               (ex + int(cos_e * axis_len), ey + int(sin_e * axis_len)), 1)
    # Right axis (ego +y)
    draw_arrow(surf, (255, 100, 100),
               (ex, ey),
               (ex + int(-sin_e * axis_len), ey + int(cos_e * axis_len)), 1)

    max_dist = math.hypot(ARENA_W, ARENA_H)
    actual_dist = math.hypot(env._tanks[0]["x"] - env._tanks[1]["x"],
                             env._tanks[0]["y"] - env._tanks[1]["y"])
    obs_dist = math.hypot(obs[7], obs[8]) * max_dist
    match = abs(obs_dist - actual_dist) < 2.0

    add_text_panel(surf, [
        (f"[7] opp_rel_x = {obs[7]:.4f}", WHITE),
        (f"    positive = opponent is AHEAD", GRAY),
        (f"[8] opp_rel_y = {obs[8]:.4f}", WHITE),
        (f"    positive = opponent is to RIGHT", GRAY),
        (f"", WHITE),
        (f"Computation:", CYAN),
        (f"  dx = opp_x - ego_x (world)", GRAY),
        (f"  dy = opp_y - ego_y (world)", GRAY),
        (f"  rel_x = (dx*cos + dy*sin) / max_dist", GRAY),
        (f"  rel_y = (-dx*sin + dy*cos) / max_dist", GRAY),
        (f"", WHITE),
        (f"Distance: obs={obs_dist:.1f}px actual={actual_dist:.1f}px", CYAN),
        (f"Match: {'YES' if match else 'NO'}", GREEN if match else RED),
        (f"", WHITE),
        (f"Orange dashed = world vector to opponent", ORANGE),
        (f"Green axis = ego forward (+x)", GREEN),
        (f"Red axis = ego right (+y)", RED),
    ])
    save(surf, "dim_07_08_opp_rel_position.png")


def gen_opp_heading(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [9..10]: opponent relative heading."""
    surf = make_base_image(env, "[9..10] Opponent Relative Heading")
    ox, oy_pos = opp_xy(env)
    opp_rad = math.radians(env._tanks[1]["angle"])
    # Draw opponent facing direction
    draw_arrow(surf, MAGENTA,
               (ox, oy_pos),
               (ox + int(math.cos(opp_rad) * 60), oy_pos + int(math.sin(opp_rad) * 60)), 2)

    rel_angle = env._tanks[1]["angle"] - env._tanks[0]["angle"]
    expected_cos = math.cos(math.radians(rel_angle))
    expected_sin = math.sin(math.radians(rel_angle))

    add_text_panel(surf, [
        (f"[9]  rel_heading_cos = {obs[9]:.4f}", WHITE),
        (f"[10] rel_heading_sin = {obs[10]:.4f}", WHITE),
        (f"", WHITE),
        (f"= cos/sin(opp_angle - ego_angle)", GRAY),
        (f"= cos/sin({env._tanks[1]['angle']:.0f} - {env._tanks[0]['angle']:.0f})", GRAY),
        (f"= cos/sin({rel_angle:.0f}°)", GRAY),
        (f"", WHITE),
        (f"Expected cos: {expected_cos:.4f}", CYAN),
        (f"Expected sin: {expected_sin:.4f}", CYAN),
        (f"Match cos: {'YES' if abs(obs[9]-expected_cos) < 0.01 else 'NO'}",
         GREEN if abs(obs[9]-expected_cos) < 0.01 else RED),
        (f"Match sin: {'YES' if abs(obs[10]-expected_sin) < 0.01 else 'NO'}",
         GREEN if abs(obs[10]-expected_sin) < 0.01 else RED),
        (f"", WHITE),
        (f"+1,0 = same direction as me", GRAY),
        (f"-1,0 = facing opposite", GRAY),
        (f"Magenta arrow = opponent facing", MAGENTA),
    ])
    save(surf, "dim_09_10_opp_heading.png")


def gen_opp_speed_alive(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [11..12]: opponent speed and alive flag."""
    surf = make_base_image(env, "[11..12] Opponent Speed & Alive")
    add_text_panel(surf, [
        (f"[11] opp_speed = {obs[11]:.4f}", WHITE),
        (f"     = {env._tanks[1]['speed']:.1f} / {TANK_SPEED}", CYAN),
        (f"", WHITE),
        (f"[12] opp_alive = {obs[12]:.1f}  ({'YES' if obs[12] > 0.5 else 'NO'})",
         GREEN if obs[12] > 0.5 else RED),
    ])
    save(surf, "dim_11_12_opp_speed_alive.png")


def gen_opp_bearing(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [13..14]: bearing cos/sin to opponent (ego frame)."""
    surf = make_base_image(env, "[13..14] Bearing to Opponent (ego frame)")
    ex, ey = ego_xy(env)

    # Bearing direction in world frame (from ego-frame bearing)
    ego_rad = math.radians(env._tanks[0]["angle"])
    cos_e = math.cos(ego_rad)
    sin_e = math.sin(ego_rad)
    # Reverse-rotate from ego frame to world
    bear_world_cos = obs[13] * cos_e - obs[14] * sin_e
    bear_world_sin = obs[13] * sin_e + obs[14] * cos_e
    draw_arrow(surf, ORANGE,
               (ex, ey),
               (ex + int(bear_world_cos * 70), ey + int(bear_world_sin * 70)), 2)

    # Expected: atan2(rel_y_ego, rel_x_ego)
    bearing_rad = math.atan2(obs[8], obs[7])  # from rel_x, rel_y in ego frame
    expected_cos = math.cos(bearing_rad)
    expected_sin = math.sin(bearing_rad)

    add_text_panel(surf, [
        (f"[13] bearing_cos = {obs[13]:.4f}", WHITE),
        (f"[14] bearing_sin = {obs[14]:.4f}", WHITE),
        (f"", WHITE),
        (f"= atan2(opp_rel_y, opp_rel_x) in ego frame", GRAY),
        (f"REDUNDANT with dims [7,8] (derivable)", RED),
        (f"", WHITE),
        (f"From rel_pos: cos={expected_cos:.4f} sin={expected_sin:.4f}", CYAN),
        (f"Match cos: {'YES' if abs(obs[13]-expected_cos) < 0.01 else 'NO'}",
         GREEN if abs(obs[13]-expected_cos) < 0.01 else RED),
        (f"Match sin: {'YES' if abs(obs[14]-expected_sin) < 0.01 else 'NO'}",
         GREEN if abs(obs[14]-expected_sin) < 0.01 else RED),
        (f"", WHITE),
        (f"Orange arrow = bearing direction (world)", ORANGE),
    ])
    save(surf, "dim_13_14_opp_bearing.png")


def gen_bullets(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [15..50]: 6 bullet slots × 6 values each."""
    max_dist = math.hypot(ARENA_W, ARENA_H)
    ego_rad = math.radians(env._tanks[0]["angle"])
    cos_e = math.cos(ego_rad)
    sin_e = math.sin(ego_rad)
    ex_px = env._tanks[0]["x"]
    ey_px = env._tanks[0]["y"]

    for slot in range(BULLET_OBS_SLOTS):
        base = 15 + slot * 6
        has_data = any(abs(obs[base + j]) > 0.001 for j in range(6))

        surf = make_base_image(env, f"[{base}..{base+5}] Bullet Slot {slot}")

        if has_data:
            # Reverse-rotate bullet pos from ego to world
            bex = obs[base + 0] * max_dist
            bey = obs[base + 1] * max_dist
            bwx = bex * cos_e - bey * sin_e + ex_px
            bwy = bex * sin_e + bey * cos_e + ey_px

            # Draw highlight circle on the bullet
            pygame.draw.circle(surf, YELLOW, (int(bwx), int(bwy) + 30), 12, 2)

            # Velocity arrow from bullet
            vex = obs[base + 2] * BULLET_SPEED
            vey = obs[base + 3] * BULLET_SPEED
            vwx = vex * cos_e - vey * sin_e
            vwy = vex * sin_e + vey * cos_e
            vscale = 20 / BULLET_SPEED
            draw_arrow(surf, YELLOW,
                       (int(bwx), int(bwy) + 30),
                       (int(bwx + vwx * vscale), int(bwy + vwy * vscale) + 30), 2)

        owner_str = "MINE" if obs[base + 4] > 0 else "THEIRS" if obs[base + 4] < 0 else "none"
        owner_color = GREEN if obs[base + 4] > 0 else RED if obs[base + 4] < 0 else GRAY

        lines: list[tuple[str, tuple[int, int, int]]] = [
            (f"Slot {slot}: {'ACTIVE' if has_data else 'EMPTY'}", CYAN if has_data else GRAY),
            (f"", WHITE),
            (f"[{base}] rel_x   = {obs[base+0]:.4f}", WHITE),
            (f"[{base+1}] rel_y   = {obs[base+1]:.4f}", WHITE),
            (f"  Ego-centric position (/ max_dist)", GRAY),
            (f"", WHITE),
            (f"[{base+2}] vel_x   = {obs[base+2]:.4f}", WHITE),
            (f"[{base+3}] vel_y   = {obs[base+3]:.4f}", WHITE),
            (f"  Ego-centric velocity (/ BULLET_SPEED)", GRAY),
            (f"", WHITE),
            (f"[{base+4}] owner   = {obs[base+4]:.1f}  ({owner_str})", owner_color),
            (f"  +1 = mine, -1 = theirs", GRAY),
            (f"", WHITE),
            (f"[{base+5}] heading = {obs[base+5]:.4f}", WHITE),
            (f"  +1 = coming at me, -1 = going away", GRAY),
        ]
        if has_data:
            lines.append((f"", WHITE))
            lines.append((f"Yellow circle = this bullet", YELLOW))

        add_text_panel(surf, lines)
        save(surf, f"dim_{base:03d}_{base+5:03d}_bullet_slot_{slot}.png")


def gen_wall_grid(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [51..100]: 5×5 local wall grid."""
    surf = make_base_image(env, "[51..100] Local Wall Grid 5x5")
    ego_col = int(env._tanks[0]["x"] // CELL_SIZE)
    ego_row = int(env._tanks[0]["y"] // CELL_SIZE)
    oy = 30

    # Highlight the 5x5 grid area
    grid_size = 2 * WALL_GRID_RADIUS + 1
    for dr in range(-WALL_GRID_RADIUS, WALL_GRID_RADIUS + 1):
        for dc in range(-WALL_GRID_RADIUS, WALL_GRID_RADIUS + 1):
            r = ego_row + dr
            c = ego_col + dc
            if 0 <= r < MAZE_ROWS and 0 <= c < MAZE_COLS:
                rx = c * CELL_SIZE
                ry = r * CELL_SIZE + oy
                color = (30, 50, 30) if (dr == 0 and dc == 0) else (20, 30, 40)
                pygame.draw.rect(surf, color, (rx, ry, CELL_SIZE, CELL_SIZE), 0)
                pygame.draw.rect(surf, DIM_GRAY, (rx, ry, CELL_SIZE, CELL_SIZE), 1)

    # Re-draw walls on top of highlight
    for seg in env._segments:
        x1, y1, x2, y2 = seg
        pygame.draw.line(surf, (100, 116, 139),
                         (int(x1), int(y1) + oy), (int(x2), int(y2) + oy), 2)

    lines: list[tuple[str, tuple[int, int, int]]] = [
        (f"5x5 grid centered on ego cell ({ego_row},{ego_col})", CYAN),
        (f"2 values per cell: has_top, has_right", GRAY),
        (f"WORLD FRAME (not ego-centric!)", RED),
        (f"", WHITE),
    ]

    for dr in range(grid_size):
        row_str = ""
        for dc in range(grid_size):
            idx = 51 + (dr * grid_size + dc) * 2
            top = "T" if obs[idx] > 0.5 else "."
            right = "R" if obs[idx + 1] > 0.5 else "."
            row_str += f"{top}{right} "
        marker = " <-- ego" if dr == WALL_GRID_RADIUS else ""
        lines.append((f"  {row_str}{marker}", WHITE))

    lines.append((f"", WHITE))
    lines.append((f"T = wall on top (north) edge", GRAY))
    lines.append((f"R = wall on right (east) edge", GRAY))
    lines.append((f". = no wall (passage)", GRAY))
    lines.append((f"", WHITE))
    lines.append((f"Green cell = ego's cell", GREEN))

    add_text_panel(surf, lines)
    save(surf, "dim_051_100_wall_grid.png")


def gen_metadata(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [101..103]: time, ego bullets, opp bullets."""
    surf = make_base_image(env, "[101..103] Metadata")
    ego_bullets = sum(1 for b in env._bullets if b["owner"] == 0)
    opp_bullets = sum(1 for b in env._bullets if b["owner"] == 1)
    add_text_panel(surf, [
        (f"[101] time_ratio    = {obs[101]:.4f}", WHITE),
        (f"      = tick / max_ticks", GRAY),
        (f"      = {env._tick} / {env._phase_config.max_episode_ticks}", CYAN),
        (f"", WHITE),
        (f"[102] ego_bullets   = {obs[102]:.4f}", WHITE),
        (f"      = active / MAX_BULLETS", GRAY),
        (f"      = {ego_bullets} / {MAX_BULLETS}", CYAN),
        (f"", WHITE),
        (f"[103] opp_bullets   = {obs[103]:.4f}", WHITE),
        (f"      = active / MAX_BULLETS", GRAY),
        (f"      = {opp_bullets} / {MAX_BULLETS}", CYAN),
    ])
    save(surf, "dim_101_103_metadata.png")


def gen_los(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [104..105]: line of sight."""
    label = "CLEAR" if obs[104] > 0.5 else "BLOCKED"
    surf = make_base_image(env, f"[104..105] Line of Sight ({label})")
    ex, ey = ego_xy(env)
    ox, oy_pos = opp_xy(env)
    has_los = obs[104] > 0.5
    color = GREEN if has_los else RED
    if has_los:
        pygame.draw.line(surf, color, (ex, ey), (ox, oy_pos), 2)
    else:
        draw_dashed(surf, color, (ex, ey), (ox, oy_pos), 2)

    max_dist = math.hypot(ARENA_W, ARENA_H)
    actual_dist = math.hypot(env._tanks[0]["x"] - env._tanks[1]["x"],
                             env._tanks[0]["y"] - env._tanks[1]["y"])

    add_text_panel(surf, [
        (f"[104] has_LOS  = {obs[104]:.1f}  ({'CLEAR' if has_los else 'BLOCKED'})", color),
        (f"      Raycast ego→opp, check wall crossings", GRAY),
        (f"", WHITE),
        (f"[105] LOS_dist = {obs[105]:.4f}", WHITE),
        (f"      = distance / max_dist when LOS=1", GRAY),
        (f"      = 0.0 when LOS=0", GRAY),
        (f"      distance = {obs[105] * max_dist:.1f}px", CYAN),
        (f"      actual   = {actual_dist:.1f}px", CYAN),
        (f"", WHITE),
        (f"{'Solid' if has_los else 'Dashed'} line = LOS {'clear' if has_los else 'blocked'}", color),
    ])
    save(surf, "dim_104_105_los.png")


def gen_raycasts(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [106..117]: 12 wall raycasts."""
    surf = make_base_image(env, "[106..117] Wall Raycasts (12 dirs, ego-relative)")
    ex, ey = ego_xy(env)
    max_dist = math.hypot(ARENA_W, ARENA_H)

    colors_12 = [
        (255, 255, 100), (255, 200, 80), (255, 160, 60), (255, 120, 40),
        (255, 80, 80), (200, 60, 120), (160, 60, 180), (120, 80, 220),
        (80, 120, 255), (60, 180, 200), (60, 220, 160), (100, 255, 120),
    ]

    lines: list[tuple[str, tuple[int, int, int]]] = [
        (f"12 rays from ego, every 30° relative to facing", CYAN),
        (f"Each = distance to nearest wall / max_dist", GRAY),
        (f"", WHITE),
    ]

    for i in range(12):
        idx = 106 + i
        dist_norm = obs[idx]
        dist_px = dist_norm * max_dist
        offset_deg = i * 30
        ray_angle = math.radians(env._tanks[0]["angle"] + offset_deg)
        rx = ex + int(math.cos(ray_angle) * dist_px)
        ry = ey + int(math.sin(ray_angle) * dist_px)

        c = colors_12[i]
        pygame.draw.line(surf, c, (ex, ey), (rx, ry), 1)
        pygame.draw.circle(surf, c, (rx, ry), 4)

        label = ""
        if offset_deg == 0:
            label = " (ahead)"
        elif offset_deg == 90:
            label = " (right)"
        elif offset_deg == 180:
            label = " (behind)"
        elif offset_deg == 270:
            label = " (left)"

        lines.append(
            (f"[{idx}] +{offset_deg:3d}° = {dist_norm:.4f} ({dist_px:.0f}px){label}", c)
        )

    add_text_panel(surf, lines)
    save(surf, "dim_106_117_raycasts.png")


def _trace_bfs_full_path(env: tank_env.TankBattleEnv) -> list[tuple[int, int]]:
    """Re-run BFS and return the full sub-cell path as pixel coordinates."""
    from collections import deque as _deque
    ego = env._tanks[0]
    opp = env._tanks[1]
    sub_size = CELL_SIZE / BFS_SUB_GRID
    total_sr = MAZE_ROWS * BFS_SUB_GRID
    total_sc = MAZE_COLS * BFS_SUB_GRID
    ego_sr = min(max(int(ego["y"] / sub_size), 0), total_sr - 1)
    ego_sc = min(max(int(ego["x"] / sub_size), 0), total_sc - 1)
    opp_sr = min(max(int(opp["y"] / sub_size), 0), total_sr - 1)
    opp_sc = min(max(int(opp["x"] / sub_size), 0), total_sc - 1)
    if ego_sr == opp_sr and ego_sc == opp_sc:
        return []
    start = (ego_sr, ego_sc)
    goal = (opp_sr, opp_sc)
    visited = {start}
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    queue = _deque([start])
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
            mr1, mc1 = sr // BFS_SUB_GRID, sc // BFS_SUB_GRID
            mr2, mc2 = nsr // BFS_SUB_GRID, nsc // BFS_SUB_GRID
            if mr1 != mr2 or mc1 != mc2:
                if dr == -1 and not env._can_move(mr1, mc1, "up"):
                    continue
                if dr == 1 and not env._can_move(mr1, mc1, "down"):
                    continue
                if dc == -1 and not env._can_move(mr1, mc1, "left"):
                    continue
                if dc == 1 and not env._can_move(mr1, mc1, "right"):
                    continue
            visited.add((nsr, nsc))
            parent[(nsr, nsc)] = (sr, sc)
            queue.append((nsr, nsc))
    if goal not in parent:
        return []
    path = [goal]
    cell = goal
    while cell in parent:
        cell = parent[cell]
        path.append(cell)
    path.reverse()
    # Convert sub-cells to pixel coords
    pixels = []
    for sr, sc in path:
        px = int(sc * sub_size + sub_size / 2)
        py = int(sr * sub_size + sub_size / 2)
        pixels.append((px, py))
    return pixels


def gen_bfs_compass(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [118..120]: BFS compass direction + distance."""
    surf = make_base_image(env, "[118..120] BFS Compass (ego-relative)")
    ex, ey = ego_xy(env)

    ego_rad = math.radians(env._tanks[0]["angle"])
    cos_e = math.cos(ego_rad)
    sin_e = math.sin(ego_rad)

    # Draw full BFS path (dotted yellow)
    full_path = _trace_bfs_full_path(env)
    if len(full_path) >= 2:
        for i in range(len(full_path) - 1):
            if i % 2 == 0:  # dotted effect
                pygame.draw.line(surf, YELLOW, full_path[i], full_path[i + 1], 2)

    bfs_cos_rel = obs[118]
    bfs_sin_rel = obs[119]
    if abs(bfs_cos_rel) > 0.01 or abs(bfs_sin_rel) > 0.01:
        # Reverse-rotate to world frame
        bfs_world_cos = bfs_cos_rel * cos_e - bfs_sin_rel * sin_e
        bfs_world_sin = bfs_cos_rel * sin_e + bfs_sin_rel * cos_e
        bx = ex + int(bfs_world_cos * 70)
        by = ey + int(bfs_world_sin * 70)
        draw_arrow(surf, CYAN, (ex, ey), (bx, by), 3)

    path_steps = len(full_path) - 1 if full_path else 0
    add_text_panel(surf, [
        (f"[118] bfs_dir_cos = {obs[118]:.4f}", WHITE),
        (f"[119] bfs_dir_sin = {obs[119]:.4f}", WHITE),
        (f"      In ego frame: +cos = forward, +sin = right", GRAY),
        (f"", WHITE),
        (f"[120] bfs_path_dist = {obs[120]:.4f}", WHITE),
        (f"      Normalized BFS path length", GRAY),
        (f"      ({path_steps} sub-cell steps)", GRAY),
        (f"", WHITE),
        (f"Cyan arrow = BFS next-step direction", CYAN),
        (f"Yellow path = full BFS route", YELLOW),
    ])
    save(surf, "dim_118_120_bfs_compass.png")


def gen_bfs_quadrant(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [121..124]: BFS quadrant one-hot hint."""
    surf = make_base_image(env, "[121..124] BFS Quadrant Hint (one-hot)")
    labels = ["FORWARD", "LEFT", "RIGHT", "BACKWARD"]
    active = "NONE"
    for i, label in enumerate(labels):
        if obs[121 + i] > 0.5:
            active = label

    hint_color = GREEN if active == "FORWARD" else YELLOW if active in ("LEFT", "RIGHT") else RED if active == "BACKWARD" else GRAY

    add_text_panel(surf, [
        (f"[121] forward  = {obs[121]:.1f}", GREEN if obs[121] > 0.5 else GRAY),
        (f"[122] left     = {obs[122]:.1f}", YELLOW if obs[122] > 0.5 else GRAY),
        (f"[123] right    = {obs[123]:.1f}", YELLOW if obs[123] > 0.5 else GRAY),
        (f"[124] backward = {obs[124]:.1f}", RED if obs[124] > 0.5 else GRAY),
        (f"", WHITE),
        (f"Active: {active}", hint_color),
        (f"", WHITE),
        (f"REDUNDANT: lossy discretization of", RED),
        (f"BFS compass [118..119]", RED),
        (f"", WHITE),
        (f"Discretizes BFS direction into 4 quadrants", GRAY),
        (f"based on angle relative to ego facing", GRAY),
    ])
    save(surf, "dim_121_124_bfs_quadrant.png")


def gen_aim(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [125..126]: aim alignment (barrel vs bearing to opponent)."""
    surf = make_base_image(env, "[125..126] Aim Alignment")
    ex, ey = ego_xy(env)
    ox, oy_pos = opp_xy(env)

    # Barrel direction (white)
    ego_rad = math.radians(env._tanks[0]["angle"])
    bx = ex + int(math.cos(ego_rad) * 80)
    by = ey + int(math.sin(ego_rad) * 80)
    draw_arrow(surf, WHITE, (ex, ey), (bx, by), 2)

    # Bearing to opponent (orange)
    draw_dashed(surf, ORANGE, (ex, ey), (ox, oy_pos), 1)

    aim_deg = math.degrees(math.atan2(obs[126], obs[125]))
    aim_color = GREEN if abs(aim_deg) < 15 else YELLOW if abs(aim_deg) < 45 else RED

    add_text_panel(surf, [
        (f"[125] aim_cos = {obs[125]:.4f}", WHITE),
        (f"[126] aim_sin = {obs[126]:.4f}", WHITE),
        (f"", WHITE),
        (f"= cos/sin(barrel_angle - bearing_to_opp)", GRAY),
        (f"", WHITE),
        (f"Aim error: {aim_deg:.1f}°", aim_color),
        (f"  +1,0 = aimed perfectly at opponent", GRAY),
        (f"  0,+1 = need to turn RIGHT 90°", GRAY),
        (f"  0,-1 = need to turn LEFT 90°", GRAY),
        (f"  -1,0 = aimed opposite (180° off)", GRAY),
        (f"", WHITE),
        (f"NOT gated by LOS — works through walls", YELLOW),
        (f"", WHITE),
        (f"White arrow = barrel", WHITE),
        (f"Orange dashed = bearing to opponent", ORANGE),
    ])
    save(surf, "dim_125_126_aim_alignment.png")


def gen_lead(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [127..129]: lead angle for predictive aim."""
    surf = make_base_image(env, "[127..129] Lead Angle (predictive aim)")
    ex, ey = ego_xy(env)
    ego_rad = math.radians(env._tanks[0]["angle"])
    cos_e = math.cos(ego_rad)
    sin_e = math.sin(ego_rad)

    # Lead direction (reverse-rotate from ego to world)
    lead_cos = obs[127]
    lead_sin = obs[128]
    if abs(lead_cos) > 0.01 or abs(lead_sin) > 0.01:
        lead_world_cos = lead_cos * cos_e - lead_sin * sin_e
        lead_world_sin = lead_cos * sin_e + lead_sin * cos_e
        lx = ex + int(lead_world_cos * 80)
        ly = ey + int(lead_world_sin * 80)
        draw_arrow(surf, MAGENTA, (ex, ey), (lx, ly), 2)

    # Barrel direction
    bx = ex + int(cos_e * 60)
    by = ey + int(sin_e * 60)
    draw_arrow(surf, WHITE, (ex, ey), (bx, by), 1)

    add_text_panel(surf, [
        (f"[127] lead_cos = {obs[127]:.4f}", WHITE),
        (f"[128] lead_sin = {obs[128]:.4f}", WHITE),
        (f"      Direction to predicted opp position", GRAY),
        (f"      (accounts for opp velocity)", GRAY),
        (f"", WHITE),
        (f"[129] lead_err = {obs[129]:.4f}", WHITE),
        (f"      = sin(barrel - lead_bearing)", GRAY),
        (f"      REDUNDANT (derivable from 127,128)", RED),
        (f"", WHITE),
        (f"Opp speed: {env._tanks[1]['speed']:.0f} px/s", CYAN),
        (f"If opp stationary: lead = aim alignment", GRAY),
        (f"", WHITE),
        (f"Magenta arrow = lead direction", MAGENTA),
        (f"White arrow = barrel direction", WHITE),
    ])
    save(surf, "dim_127_129_lead_angle.png")


def gen_shot_difficulty(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [130..131]: angular width + time to impact."""
    surf = make_base_image(env, "[130..131] Shot Difficulty")
    dist = math.hypot(env._tanks[0]["x"] - env._tanks[1]["x"],
                      env._tanks[0]["y"] - env._tanks[1]["y"])
    ang_w_deg = obs[130] * 180
    tti_sec = obs[131] * BULLET_LIFETIME

    add_text_panel(surf, [
        (f"[130] angular_width = {obs[130]:.4f}", WHITE),
        (f"      = atan(TANK_WIDTH / dist) / π", GRAY),
        (f"      = atan({TANK_WIDTH} / {dist:.0f}) / π", GRAY),
        (f"      = {ang_w_deg:.1f}°", CYAN),
        (f"      (bigger = easier target)", GRAY),
        (f"", WHITE),
        (f"[131] time_to_impact = {obs[131]:.4f}", WHITE),
        (f"      = dist / (BULLET_SPEED * LIFETIME)", GRAY),
        (f"      = {dist:.0f} / ({BULLET_SPEED} * {BULLET_LIFETIME})", GRAY),
        (f"      = {tti_sec:.2f}s", CYAN),
    ])
    save(surf, "dim_130_131_shot_difficulty.png")


def gen_threats(env: tank_env.TankBattleEnv, obs: np.ndarray, label: str,
               base: int, radius: float, owner_label: str, filename: str) -> None:
    """Generic threat visualization for dims [132..135] or [136..139]."""
    surf = make_base_image(env, f"[{base}..{base+3}] {label}")
    ex, ey = ego_xy(env)

    # Draw threat radius circle
    pygame.draw.circle(surf, (80, 80, 40), (ex, ey), int(radius), 1)

    count_val = obs[base]
    dist_val = obs[base + 1]
    cos_val = obs[base + 2]
    sin_val = obs[base + 3]

    # Draw nearest threat direction
    if count_val > 0.001:
        ego_rad = math.radians(env._tanks[0]["angle"])
        cos_e = math.cos(ego_rad)
        sin_e = math.sin(ego_rad)
        t_world_cos = cos_val * cos_e - sin_val * sin_e
        t_world_sin = cos_val * sin_e + sin_val * cos_e
        t_dist_px = dist_val * radius
        tx = ex + int(t_world_cos * t_dist_px)
        ty = ey + int(t_world_sin * t_dist_px)
        draw_arrow(surf, RED, (ex, ey), (tx, ty), 2)
        pygame.draw.circle(surf, RED, (tx, ty), 6, 2)

    add_text_panel(surf, [
        (f"[{base}] count     = {count_val:.4f} ({count_val * MAX_BULLETS:.0f} bullets)", WHITE),
        (f"    {owner_label} bullets within {radius:.0f}px", GRAY),
        (f"    heading toward me (dot > 0.5)", GRAY),
        (f"", WHITE),
        (f"[{base+1}] near_dist = {dist_val:.4f}", WHITE),
        (f"    = nearest / {radius:.0f}. 0 = on top of me", GRAY),
        (f"", WHITE),
        (f"[{base+2}] near_cos  = {cos_val:.4f}", WHITE),
        (f"[{base+3}] near_sin  = {sin_val:.4f}", WHITE),
        (f"    Ego-frame angle to nearest threat", GRAY),
        (f"", WHITE),
        (f"Circle = threat radius ({radius:.0f}px)", YELLOW),
        (f"Red arrow = nearest threat direction", RED),
    ])
    save(surf, filename)


def gen_tactical(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [140..141]: fire cooldown, opponent facing me."""
    surf = make_base_image(env, "[140..141] Tactical")

    ticks_since = env._tick - env._last_fire_tick[0]
    expected_cd = min(ticks_since / FIRE_COOLDOWN_TICKS, 1.0) if FIRE_COOLDOWN_TICKS > 0 else 1.0

    add_text_panel(surf, [
        (f"[140] fire_cooldown = {obs[140]:.4f}", WHITE),
        (f"      = ticks_since_fired / cooldown_ticks", GRAY),
        (f"      = {ticks_since} / {FIRE_COOLDOWN_TICKS}", CYAN),
        (f"      expected: {expected_cd:.4f}", CYAN),
        (f"      1.0 = ready, <1.0 = cooling down", GRAY),
        (f"      REDUNDANT with can_fire [6]", RED),
        (f"", WHITE),
        (f"[141] opp_facing_me = {obs[141]:.4f}", WHITE),
        (f"      = cos(opp_heading - opp_to_ego_bearing)", GRAY),
        (f"      +1 = opponent aiming at me", GREEN if obs[141] > 0.7 else GRAY),
        (f"      -1 = opponent facing away", GRAY if obs[141] > -0.7 else GREEN),
    ])
    save(surf, "dim_140_141_tactical.png")


def gen_barrel_wall(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dim [142]: barrel wall distance."""
    surf = make_base_image(env, "[142] Barrel Wall Distance")
    ex, ey = ego_xy(env)
    max_dist = math.hypot(ARENA_W, ARENA_H)
    dist_px = obs[142] * max_dist
    ego_rad = math.radians(env._tanks[0]["angle"])
    wx = ex + int(math.cos(ego_rad) * dist_px)
    wy = ey + int(math.sin(ego_rad) * dist_px)
    pygame.draw.line(surf, YELLOW, (ex, ey), (wx, wy), 2)
    pygame.draw.circle(surf, RED, (wx, wy), 5)

    # Compare with raycast[0] (dim 106)
    raycast_0 = obs[106]

    add_text_panel(surf, [
        (f"[142] barrel_wall = {obs[142]:.4f}", WHITE),
        (f"      = raycast along barrel direction", GRAY),
        (f"      = {dist_px:.0f}px to nearest wall", CYAN),
        (f"", WHITE),
        (f"Raycast[0] (dim 106) = {raycast_0:.4f}", YELLOW),
        (f"REDUNDANT: same as raycast at 0° offset", RED),
        (f"Difference: {abs(obs[142] - raycast_0):.6f}", RED),
        (f"", WHITE),
        (f"Yellow line = barrel raycast", YELLOW),
        (f"Red dot = wall hit point", RED),
    ])
    save(surf, "dim_142_barrel_wall.png")


def gen_firing_solution(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dims [143..145]: firing solution trace."""
    surf = make_base_image(env, "[143..145] Firing Solution")
    oy = 30

    # Draw the firing solution path
    fs_segments = getattr(env, "_last_firing_solution_segments", [])
    fs_hit = getattr(env, "_last_firing_solution_hit", False)
    fs_color = GREEN if fs_hit else RED

    for i, seg in enumerate(fs_segments):
        sx1, sy1, sx2, sy2 = seg
        pygame.draw.line(surf, fs_color,
                         (int(sx1), int(sy1) + oy),
                         (int(sx2), int(sy2) + oy), 2)
        if i > 0:
            pygame.draw.circle(surf, YELLOW, (int(sx1), int(sy1) + oy), 4, 1)

    if fs_hit and fs_segments:
        last = fs_segments[-1]
        pygame.draw.circle(surf, GREEN, (int(last[2]), int(last[3]) + oy), 8, 2)

    max_range = BULLET_SPEED * BULLET_LIFETIME

    add_text_panel(surf, [
        (f"[143] shot_would_hit  = {obs[143]:.1f}  ({'HIT' if obs[143] > 0.5 else 'MISS'})",
         GREEN if obs[143] > 0.5 else RED),
        (f"      Trace bullet from barrel through", GRAY),
        (f"      wall bounces (up to 10), max {max_range:.0f}px", GRAY),
        (f"", WHITE),
        (f"[144] shot_hit_dist   = {obs[144]:.4f}", WHITE),
        (f"      = path distance to hit / max_range", GRAY),
        (f"      = {obs[144] * max_range:.0f}px along bounce path", CYAN),
        (f"", WHITE),
        (f"[145] shot_would_hit_self = {obs[145]:.1f}", WHITE),
        (f"      {'DANGER: ricochet hits self!' if obs[145] > 0.5 else 'Safe: no self-hit'}",
         RED if obs[145] > 0.5 else GREEN),
        (f"", WHITE),
        (f"Trace segments: {len(fs_segments)}", CYAN),
        (f"{'Green' if fs_hit else 'Red'} path = firing solution", fs_color),
        (f"Yellow circles = bounce points", YELLOW),
    ])
    save(surf, "dim_143_145_firing_solution.png")


def gen_ammo(env: tank_env.TankBattleEnv, obs: np.ndarray) -> None:
    """Dim [146]: ammo fraction."""
    surf = make_base_image(env, "[146] Ammo Fraction")
    max_ammo = max(env._phase_config.max_ammo_per_life, 1)
    add_text_panel(surf, [
        (f"[146] ammo = {obs[146]:.4f}", WHITE),
        (f"      = remaining / max_per_life", GRAY),
        (f"      = {env._ammo[0]} / {max_ammo}", CYAN),
        (f"", WHITE),
        (f"999 = effectively unlimited", GRAY),
    ])
    save(surf, "dim_146_ammo.png")


# ═══════════════════════════════════════════════════════════════════
# Main: set up scenarios and generate all images
# ═══════════════════════════════════════════════════════════════════

def place_tank(env: tank_env.TankBattleEnv, pid: int, row: int, col: int, angle: float) -> None:
    cx, cy = cell_center(row, col)
    env._tanks[pid]["x"] = float(cx)
    env._tanks[pid]["y"] = float(cy)
    env._tanks[pid]["angle"] = angle
    env._tanks[pid]["alive"] = True
    env._tanks[pid]["speed"] = 0.0


def refresh_bfs(env: tank_env.TankBattleEnv) -> None:
    ego = env._tanks[0]
    opp = env._tanks[1]
    env._cached_bfs = env._bfs_path_direction(ego["x"], ego["y"], opp["x"], opp["y"])


def setup_scenario(env: gym.Env, raw: tank_env.TankBattleEnv, prefix: str, label: str) -> np.ndarray:
    """Reset env, set global prefix, print header, return obs after refresh_bfs."""
    global _scenario_prefix
    _scenario_prefix = prefix
    print(f"\n{'='*60}")
    print(f"[{prefix}] {label}")
    print(f"{'='*60}")
    env.reset(seed=42)
    return raw  # caller places tanks then calls finish_scenario


def finish_scenario(raw: tank_env.TankBattleEnv) -> np.ndarray:
    """Refresh BFS and return observation."""
    refresh_bfs(raw)
    obs = raw._get_observation(player=0)
    assert obs.shape == (OBS_DIM,), f"Shape {obs.shape} != ({OBS_DIM},)"
    return obs


def main() -> None:
    print(f"Generating observation debug images in {OUTPUT_DIR}/")
    print(f"OBS_DIM = {OBS_DIM}")
    global _scenario_prefix

    # Clear old images
    for old in OUTPUT_DIR.glob("*.png"):
        old.unlink()

    env = gym.make("TankBattle-v0", training_phase=2, render_mode="rgb_array")
    raw = env.unwrapped

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 01: Baseline — facing each other, clear LOS, good aim
    # Tests: all ego, opp, LOS clear, aim aligned, firing solution HIT
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s01_baseline"
    print(f"\n{'='*60}")
    print(f"[s01] Baseline: adjacent, facing each other, clear LOS")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)      # facing right
    place_tank(raw, 1, 2, 5, angle=180)    # facing left (toward ego)
    obs = finish_scenario(raw)
    gen_ego_position(raw, obs)
    gen_ego_angle(raw, obs)
    gen_ego_speed(raw, obs)
    gen_ego_alive_canfire(raw, obs)
    gen_opp_position(raw, obs)
    gen_opp_heading(raw, obs)
    gen_opp_speed_alive(raw, obs)
    gen_opp_bearing(raw, obs)
    gen_wall_grid(raw, obs)
    gen_los(raw, obs)          # should be CLEAR
    gen_raycasts(raw, obs)
    gen_bfs_compass(raw, obs)
    gen_bfs_quadrant(raw, obs)
    gen_aim(raw, obs)          # should be perfectly aimed (cos≈1)
    gen_lead(raw, obs)         # no movement → lead = aim
    gen_shot_difficulty(raw, obs)
    gen_threats(raw, obs, "Enemy Bullet Threat", 132, 50.0, "Enemy", "dim_132_135_threat.png")
    gen_threats(raw, obs, "Self-Bullet Threat", 136, 120.0, "Own", "dim_136_139_self_threat.png")
    gen_tactical(raw, obs)
    gen_barrel_wall(raw, obs)
    gen_firing_solution(raw, obs)  # should be HIT
    gen_ammo(raw, obs)
    gen_metadata(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 02: LOS blocked — behind a wall
    # Tests: LOS=0, BFS path around wall, aim works through walls
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s02_los_blocked"
    print(f"\n{'='*60}")
    print(f"[s02] LOS blocked: opponent around corner")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 3, 2, angle=315)    # facing up-right
    place_tank(raw, 1, 1, 4, angle=180)    # far corner
    obs = finish_scenario(raw)
    gen_los(raw, obs)          # should be BLOCKED
    gen_bfs_compass(raw, obs)  # path around walls
    gen_aim(raw, obs)          # still shows aim (not gated by LOS)
    gen_firing_solution(raw, obs)  # likely MISS (bounced)
    gen_raycasts(raw, obs)
    gen_wall_grid(raw, obs)
    gen_opp_position(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 03: Aimed away — ego facing opposite direction
    # Tests: aim_cos ≈ -1, firing solution MISS, BFS behind
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s03_aimed_away"
    print(f"\n{'='*60}")
    print(f"[s03] Aimed away: ego facing wrong direction")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=180)    # facing LEFT (away from opp)
    place_tank(raw, 1, 2, 5, angle=180)    # opp to the right
    obs = finish_scenario(raw)
    gen_aim(raw, obs)          # should be cos≈-1 (180° off)
    gen_firing_solution(raw, obs)  # should be MISS
    gen_bfs_compass(raw, obs)  # should point backward
    gen_bfs_quadrant(raw, obs)  # should be BACKWARD
    gen_opp_position(raw, obs)  # opp behind ego
    gen_los(raw, obs)          # LOS exists but aimed away

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 04: Aimed 90° off — ego perpendicular
    # Tests: aim_cos ≈ 0, aim_sin shows turn direction
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s04_aim_90deg"
    print(f"\n{'='*60}")
    print(f"[s04] Aim 90° off: ego facing perpendicular to opponent")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=90)     # facing DOWN
    place_tank(raw, 1, 2, 5, angle=180)    # opp to the right
    obs = finish_scenario(raw)
    gen_aim(raw, obs)          # cos≈0, sin shows direction to turn
    gen_opp_position(raw, obs)
    gen_opp_bearing(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 05: Moving opponent — lead angle differs from aim
    # Tests: lead_cos/sin differ from aim, lead_err nonzero
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s05_moving_opp"
    print(f"\n{'='*60}")
    print(f"[s05] Moving opponent: lead angle test")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 2, angle=0)      # facing right
    place_tank(raw, 1, 2, 6, angle=90)     # facing down, moving
    raw._tanks[1]["speed"] = TANK_SPEED
    obs = finish_scenario(raw)
    gen_lead(raw, obs)         # lead should differ from aim
    gen_aim(raw, obs)          # aim to current pos
    gen_opp_heading(raw, obs)  # facing perpendicular
    gen_opp_speed_alive(raw, obs)  # speed = 1.0
    gen_shot_difficulty(raw, obs)
    raw._tanks[1]["speed"] = 0.0

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 06: Stationary opponent — lead angle = aim angle
    # Tests: lead_cos/sin ≈ aim_cos/sin, lead_err ≈ 0
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s06_stationary_opp"
    print(f"\n{'='*60}")
    print(f"[s06] Stationary opponent: lead = aim")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 2, angle=0)      # facing right
    place_tank(raw, 1, 2, 6, angle=90)     # facing down, NOT moving
    obs = finish_scenario(raw)
    gen_lead(raw, obs)         # should match aim
    gen_aim(raw, obs)
    gen_opp_speed_alive(raw, obs)  # speed = 0

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 07: Self-hit — firing at nearby wall, ricochet
    # Tests: fs_self=1, fs_hit=0
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s07_self_hit"
    print(f"\n{'='*60}")
    print(f"[s07] Self-hit: bullet bounces back")
    print(f"{'='*60}")
    env.reset(seed=42)
    cx, cy = cell_center(2, 0)
    raw._tanks[0]["x"] = float(cx)
    raw._tanks[0]["y"] = float(cy)
    raw._tanks[0]["angle"] = 180.0         # facing left wall (very close)
    raw._tanks[0]["alive"] = True
    place_tank(raw, 1, 4, 8, angle=0)
    obs = finish_scenario(raw)
    gen_firing_solution(raw, obs)  # should show self_hit=1
    gen_raycasts(raw, obs)         # barrel raycast should be very short

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 08: Direct hit — aimed and clear LOS
    # Tests: fs_hit=1, fs_self=0, fs_dist > 0
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s08_direct_hit"
    print(f"\n{'='*60}")
    print(f"[s08] Direct hit: firing solution connects")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 3, 1, angle=0)      # facing right
    place_tank(raw, 1, 3, 4, angle=0)      # same row, rightward
    obs = finish_scenario(raw)
    gen_firing_solution(raw, obs)  # should be HIT, no self-hit
    gen_los(raw, obs)              # clear LOS
    gen_aim(raw, obs)              # perfectly aligned

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 09: Bullets on field — threats active
    # Tests: bullet slots, enemy threat count>0, metadata bullets>0
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s09_bullets_active"
    print(f"\n{'='*60}")
    print(f"[s09] Bullets on field: threats active")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 3, 3, angle=0)
    place_tank(raw, 1, 3, 6, angle=180)
    ego_bullet = raw._create_bullet(0, raw._tanks[0])
    raw._bullets.append(ego_bullet)
    raw._last_fire_tick[0] = raw._tick
    opp_bullet = raw._create_bullet(1, raw._tanks[1])
    raw._bullets.append(opp_bullet)
    obs = finish_scenario(raw)
    gen_bullets(raw, obs)      # 2 bullets visible
    gen_threats(raw, obs, "Enemy Bullet Threat", 132, 50.0, "Enemy", "dim_132_135_threat.png")
    gen_threats(raw, obs, "Self-Bullet Threat", 136, 120.0, "Own", "dim_136_139_self_threat.png")
    gen_tactical(raw, obs)     # fire_cd should be 0 (just fired)
    gen_metadata(raw, obs)     # ego_bullets=1, opp_bullets=1

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 10: No bullets — threats inactive
    # Tests: all bullet slots zero, threat count=0
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s10_no_bullets"
    print(f"\n{'='*60}")
    print(f"[s10] No bullets: threats inactive")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 3, 3, angle=0)
    place_tank(raw, 1, 3, 6, angle=180)
    obs = finish_scenario(raw)
    gen_bullets(raw, obs)      # all empty slots
    gen_threats(raw, obs, "Enemy Bullet Threat", 132, 50.0, "Enemy", "dim_132_135_threat.png")
    gen_threats(raw, obs, "Self-Bullet Threat", 136, 120.0, "Own", "dim_136_139_self_threat.png")
    gen_metadata(raw, obs)     # ego_bullets=0, opp_bullets=0

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 11: Ego moving forward — speed > 0
    # Tests: ego_speed = 1.0
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s11_ego_moving"
    print(f"\n{'='*60}")
    print(f"[s11] Ego moving: speed test")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)
    raw._tanks[0]["speed"] = TANK_SPEED     # full speed forward
    place_tank(raw, 1, 2, 7, angle=180)
    obs = finish_scenario(raw)
    gen_ego_speed(raw, obs)    # should be 1.0
    gen_ego_position(raw, obs)
    raw._tanks[0]["speed"] = 0.0

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 12: Ego at different angles — 0°, 90°, 180°, 270°
    # Tests: ego_cos/sin values, raycast rotation
    # ══════════════════════════════════════════════════════════════
    for angle, label in [(0, "right"), (90, "down"), (180, "left"), (270, "up")]:
        _scenario_prefix = f"s12_angle_{angle}"
        print(f"\n{'='*60}")
        print(f"[s12] Ego angle {angle}° (facing {label})")
        print(f"{'='*60}")
        env.reset(seed=42)
        place_tank(raw, 0, 3, 4, angle=angle)
        place_tank(raw, 1, 1, 7, angle=0)
        obs = finish_scenario(raw)
        gen_ego_angle(raw, obs)
        gen_raycasts(raw, obs)
        gen_opp_position(raw, obs)
        gen_wall_grid(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 13: Opponent behind — bearing test
    # Tests: opp_bearing should point backward
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s13_opp_behind"
    print(f"\n{'='*60}")
    print(f"[s13] Opponent behind ego")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 5, angle=0)      # facing right
    place_tank(raw, 1, 2, 2, angle=0)      # opponent to the LEFT
    obs = finish_scenario(raw)
    gen_opp_position(raw, obs)   # rel_x should be negative
    gen_opp_bearing(raw, obs)    # bearing should point backward
    gen_bfs_quadrant(raw, obs)   # should be BACKWARD

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 14: Opponent to the left — bearing test
    # Tests: opp_bearing left
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s14_opp_left"
    print(f"\n{'='*60}")
    print(f"[s14] Opponent to the left of ego")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 3, 4, angle=0)      # facing right
    place_tank(raw, 1, 1, 4, angle=0)      # above = left in ego frame
    obs = finish_scenario(raw)
    gen_opp_position(raw, obs)
    gen_opp_bearing(raw, obs)    # bearing sin < 0 (left)
    gen_bfs_quadrant(raw, obs)   # should be LEFT

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 15: Opponent facing away — tactical test
    # Tests: opp_facing_me ≈ -1
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s15_opp_facing_away"
    print(f"\n{'='*60}")
    print(f"[s15] Opponent facing away")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)
    place_tank(raw, 1, 2, 5, angle=0)      # facing SAME direction (away)
    obs = finish_scenario(raw)
    gen_tactical(raw, obs)       # opp_facing_me should be ≈ -1
    gen_opp_heading(raw, obs)    # heading cos should be +1 (same dir)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 16: Close range — shot difficulty easy
    # Tests: angular_width large, TTI small
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s16_close_range"
    print(f"\n{'='*60}")
    print(f"[s16] Close range: easy shot")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)
    place_tank(raw, 1, 2, 4, angle=180)    # 1 cell away
    obs = finish_scenario(raw)
    gen_shot_difficulty(raw, obs)  # angular_width large, TTI small
    gen_los(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 17: Long range — shot difficulty hard
    # Tests: angular_width small, TTI large
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s17_long_range"
    print(f"\n{'='*60}")
    print(f"[s17] Long range: hard shot")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 4, 0, angle=0)
    place_tank(raw, 1, 4, 8, angle=180)    # max horizontal distance
    obs = finish_scenario(raw)
    gen_shot_difficulty(raw, obs)  # angular_width small, TTI large
    gen_los(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 18: Ego in corner — raycasts short on 2 sides
    # Tests: raycast distances vary dramatically
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s18_corner_raycasts"
    print(f"\n{'='*60}")
    print(f"[s18] Corner position: raycast test")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 0, 0, angle=45)     # top-left corner, facing diagonal
    place_tank(raw, 1, 5, 8, angle=0)
    obs = finish_scenario(raw)
    gen_raycasts(raw, obs)     # some very short, some long
    gen_wall_grid(raw, obs)    # edge cells should be all walls
    gen_ego_position(raw, obs) # near (0,0)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 19: Center position — raycasts more uniform
    # Tests: contrast with corner raycasts
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s19_center_raycasts"
    print(f"\n{'='*60}")
    print(f"[s19] Center position: raycast test")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 3, 4, angle=0)      # center of maze
    place_tank(raw, 1, 0, 0, angle=0)
    obs = finish_scenario(raw)
    gen_raycasts(raw, obs)
    gen_wall_grid(raw, obs)
    gen_ego_position(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 20: Can't fire — just fired, cooldown active
    # Tests: can_fire=0, fire_cd < 1.0
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s20_cooldown"
    print(f"\n{'='*60}")
    print(f"[s20] Fire cooldown active")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)
    place_tank(raw, 1, 2, 6, angle=180)
    raw._last_fire_tick[0] = raw._tick      # just fired
    ego_bullet = raw._create_bullet(0, raw._tanks[0])
    raw._bullets.append(ego_bullet)
    obs = finish_scenario(raw)
    gen_ego_alive_canfire(raw, obs)  # can_fire should still be 1 if cooldown=0 ticks ago
    gen_tactical(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 21: Diagonal BFS — long path through maze
    # Tests: BFS path wraps around multiple walls
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s21_long_bfs"
    print(f"\n{'='*60}")
    print(f"[s21] Long BFS path: opposite corners")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 5, 0, angle=0)      # bottom-left
    place_tank(raw, 1, 0, 8, angle=180)    # top-right
    obs = finish_scenario(raw)
    gen_bfs_compass(raw, obs)  # long winding path
    gen_bfs_quadrant(raw, obs)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 22: Same cell BFS — very close
    # Tests: BFS returns (0,0,0)
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s22_same_cell_bfs"
    print(f"\n{'='*60}")
    print(f"[s22] Same cell BFS: adjacent tanks")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)
    # Place opp in same maze cell but offset slightly
    raw._tanks[1]["x"] = raw._tanks[0]["x"] + 20
    raw._tanks[1]["y"] = raw._tanks[0]["y"]
    raw._tanks[1]["angle"] = 180.0
    raw._tanks[1]["alive"] = True
    obs = finish_scenario(raw)
    gen_bfs_compass(raw, obs)  # should be 0,0,0 or very short
    gen_los(raw, obs)          # very close, clear LOS

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 23: Opponent dead — signals zeroed
    # Tests: opp_alive=0, LOS=0, aim/lead/threat zeroed
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s23_opp_dead"
    print(f"\n{'='*60}")
    print(f"[s23] Opponent dead: signals zeroed")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)
    place_tank(raw, 1, 2, 6, angle=180)
    raw._tanks[1]["alive"] = False
    obs = finish_scenario(raw)
    gen_opp_speed_alive(raw, obs)  # alive=0
    gen_los(raw, obs)              # should be 0
    gen_aim(raw, obs)              # should be 0,0
    gen_lead(raw, obs)             # should be 0,0,0
    gen_shot_difficulty(raw, obs)  # should be 0,0
    gen_firing_solution(raw, obs)  # should be MISS

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 24: Low ammo
    # Tests: ammo fraction < 1
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s24_low_ammo"
    print(f"\n{'='*60}")
    print(f"[s24] Low ammo")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 2, 3, angle=0)
    place_tank(raw, 1, 2, 6, angle=180)
    raw._ammo[0] = 3  # low ammo
    obs = finish_scenario(raw)
    gen_ammo(raw, obs)         # should be < 1.0
    gen_ego_alive_canfire(raw, obs)  # can_fire still true (ammo > 0)

    # ══════════════════════════════════════════════════════════════
    # SCENARIO 25: Bank shot — bounce off wall then hit opponent
    # Tests: fs_hit=1, segments >= 2 (at least one bounce)
    # ══════════════════════════════════════════════════════════════
    _scenario_prefix = "s25_bank_shot"
    print(f"\n{'='*60}")
    print(f"[s25] Bank shot: wall bounce → hit opponent")
    print(f"{'='*60}")
    env.reset(seed=42)
    place_tank(raw, 0, 1, 1, angle=15)     # slight angle off horizontal
    place_tank(raw, 1, 2, 1, angle=0)      # one row below, same col
    obs = finish_scenario(raw)
    gen_firing_solution(raw, obs)  # should be HIT with >= 2 segments
    gen_los(raw, obs)              # may or may not have LOS

    env.close()

    n_images = len(list(OUTPUT_DIR.glob("*.png")))
    print(f"\n{'='*60}")
    print(f"Done! {n_images} images saved to {OUTPUT_DIR}/")
    print(f"OBS_DIM = {OBS_DIM}")


if __name__ == "__main__":
    main()
