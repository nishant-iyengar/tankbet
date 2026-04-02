"""TankBattle Gymnasium environment for RL training."""

from __future__ import annotations

import json
import math
import os
from collections import deque
from pathlib import Path
from typing import Any

import gymnasium
import numpy as np
import torch
from gymnasium import spaces

from action_table import decode_action
from phase_config import PHASE_CONFIGS, PhaseConfig

# ---------------------------------------------------------------------------
# Load constants from the shared JSON file (single source of truth).
# ---------------------------------------------------------------------------
_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "game-engine"
    / "src"
    / "constants.json"
)
with open(_CONSTANTS_PATH) as _f:
    _CONSTANTS = json.load(_f)

ENV_VERSION: int = _CONSTANTS["ENV_VERSION"]
CELL_SIZE: int = _CONSTANTS["CELL_SIZE"]
MAZE_COLS: int = _CONSTANTS["MAZE_COLS"]
MAZE_ROWS: int = _CONSTANTS["MAZE_ROWS"]
ARENA_W: int = MAZE_COLS * CELL_SIZE  # 1080
ARENA_H: int = MAZE_ROWS * CELL_SIZE  # 720

TANK_SPEED: float = _CONSTANTS["TANK_SPEED"]
REVERSE_SPEED_FACTOR: float = _CONSTANTS["REVERSE_SPEED_FACTOR"]
TANK_ROTATION_SPEED: float = _CONSTANTS["TANK_ROTATION_SPEED"]
TANK_WIDTH: int = _CONSTANTS["TANK_WIDTH"]
TANK_HEIGHT: int = _CONSTANTS["TANK_HEIGHT"]
BARREL_LENGTH: int = _CONSTANTS["BARREL_LENGTH"]

BULLET_SPEED: float = _CONSTANTS["BULLET_SPEED"]
BULLET_LIFETIME: float = _CONSTANTS["BULLET_LIFETIME_SECONDS"]
BULLET_COOLDOWN_MS: float = _CONSTANTS["BULLET_FIRE_COOLDOWN_MS"]
MAX_BULLETS: int = _CONSTANTS["MAX_BULLETS_PER_TANK"]
BULLET_HIT_RADIUS: int = _CONSTANTS["BULLET_HIT_RADIUS"]
BULLET_RADIUS: int = _CONSTANTS["BULLET_RADIUS"]
TANK_HITBOX_SHRINK: int = _CONSTANTS["TANK_HITBOX_SHRINK"]

CORNER_SHIELD_PADDING: int = _CONSTANTS["CORNER_SHIELD_PADDING"]
WALL_FRICTION: float = _CONSTANTS["WALL_FRICTION"]
MAZE_MIN_WALL_FRACTION: float = _CONSTANTS["MAZE_MIN_WALL_FRACTION"]

SERVER_TICK_HZ: int = _CONSTANTS["SERVER_TICK_HZ"]
PHYSICS_STEP: float = 1.0 / SERVER_TICK_HZ

DECISION_HZ: int = _CONSTANTS["BOT_DECISION_HZ"]
DECISION_INTERVAL = SERVER_TICK_HZ // DECISION_HZ  # 60 // 20 = 3

BULLET_WALL_CLEARANCE: int = _CONSTANTS["BULLET_WALL_CLEARANCE"]
MAX_BULLET_BOUNCES: int = _CONSTANTS["MAX_BULLET_BOUNCES"]
THREAT_RADIUS_ENEMY: float = _CONSTANTS["THREAT_RADIUS_ENEMY"]
THREAT_RADIUS_SELF: float = _CONSTANTS["THREAT_RADIUS_SELF"]
THREAT_HEADING_THRESHOLD: float = _CONSTANTS["THREAT_HEADING_THRESHOLD"]

FIRE_COOLDOWN_TICKS = int(BULLET_COOLDOWN_MS / 1000.0 * SERVER_TICK_HZ)

# Near-miss dodge threshold (pixels)

# Overlap distance — tanks are essentially on top of each other (pixels)

# ---------------------------------------------------------------------------
# Observation space dimensions
# ---------------------------------------------------------------------------
# 7 (ego) + 8 (opponent ego-centric) + 2 (lives)
# + 36 (bullets: 6 slots x 6 values) + 50 (local walls: 5x5 x 2)
# + 3 (metadata) + 2 (LOS) + 12 (wall raycasts 12 dirs)
# + 3 (BFS compass) = 123
OBS_DIM = 147  # removed lives (2 values) — each episode is 1 round
BULLET_OBS_SLOTS = 6
WALL_GRID_RADIUS = 2  # 5x5 grid: center ± 2
RAYCAST_DIRS = 12  # every 30°
BFS_SUB_GRID = 4  # subdivide each maze cell into 4x4 for finer BFS pathfinding


def _make_tank(x: float, y: float, angle: float = 0.0) -> dict[str, Any]:
    """Create a tank state dict. Lives are tracked separately in _lives."""
    return {
        "x": x,
        "y": y,
        "angle": angle,
        "speed": 0.0,
        "alive": True,
    }


def _get_spawn_positions(
    cols: int, rows: int, rng: np.random.Generator,
    distance_fraction: tuple[float, float] = (0.10, 1.0),
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Pick two random cell centers within a distance range.

    distance_fraction: (min, max) as fraction of arena diagonal.
    """
    total_w = cols * CELL_SIZE
    total_h = rows * CELL_SIZE
    diagonal = math.sqrt(total_w * total_w + total_h * total_h)
    min_distance = diagonal * distance_fraction[0]
    max_distance = diagonal * distance_fraction[1]

    best_pair = (
        (CELL_SIZE / 2, CELL_SIZE / 2),
        ((cols - 1) * CELL_SIZE + CELL_SIZE / 2, (rows - 1) * CELL_SIZE + CELL_SIZE / 2),
    )
    best_dist = -1.0

    for _ in range(200):
        col1 = int(rng.integers(0, cols))
        row1 = int(rng.integers(0, rows))
        col2 = int(rng.integers(0, cols))
        row2 = int(rng.integers(0, rows))

        p1 = (col1 * CELL_SIZE + CELL_SIZE / 2, row1 * CELL_SIZE + CELL_SIZE / 2)
        p2 = (col2 * CELL_SIZE + CELL_SIZE / 2, row2 * CELL_SIZE + CELL_SIZE / 2)

        dx = p1[0] - p2[0]
        dy = p1[1] - p2[1]
        dist = math.sqrt(dx * dx + dy * dy)

        if min_distance <= dist <= max_distance:
            return (p1, p2)

        # Track closest to the valid range as fallback
        if min_distance <= dist:
            dist_to_range = dist - max_distance
        else:
            dist_to_range = min_distance - dist
        if best_dist < 0 or dist_to_range < best_dist:
            best_dist = dist_to_range
            best_pair = (p1, p2)

    return best_pair


class TankBattleEnv(gymnasium.Env):
    """Tank Battle Gymnasium environment — full physics implementation.

    Maze data is pre-generated via TypeScript (scripts/generate-mazes.ts).
    Spawn positions are generated fresh each round via Python RNG for variety.
    Uses AABB collision simplification for initial training.
    """

    metadata = {"render_modes": ["human", "rgb_array"], "render_fps": SERVER_TICK_HZ}

    def __init__(
        self,
        render_mode: str | None = None,
        maze_file: str = "data/mazes.json",
        discount_factor: float = 0.99,
        opponent_model_path: str | None = None,
        training_phase: int = 0,
    ) -> None:
        super().__init__()

        # Curriculum phase ------------------------------------------------
        self._training_phase = training_phase
        self._phase_config: PhaseConfig = PHASE_CONFIGS[training_phase]

        # Self-play opponent (loaded after spaces are defined) ---------------
        self._opponent_model: torch.nn.Module | None = None
        self._opponent_device: str = "cpu"
        self._opponent_model_path = opponent_model_path

        # Load pre-generated mazes ----------------------------------------
        # Select maze file based on phase's maze_tier setting
        tier = self._phase_config.maze_tier
        tier_file = Path(__file__).parent / f"data/mazes_{tier}.json"
        fallback_file = Path(__file__).parent / maze_file
        if tier_file.exists():
            maze_path = tier_file
        else:
            maze_path = fallback_file
        with open(maze_path) as f:
            self._mazes: list[dict[str, Any]] = json.load(f)

        # Discount factor for PBRS (must match agent's gamma) -------------
        self.discount_factor = discount_factor


        # Spaces -----------------------------------------------------------
        self.observation_space = spaces.Box(
            low=-1.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32
        )
        self.action_space = spaces.Discrete(18)

        # Load self-play opponent now that spaces are defined ---------------
        if self._opponent_model_path is not None:
            self._load_opponent_model(self._opponent_model_path)

        # Render -----------------------------------------------------------
        assert render_mode is None or render_mode in self.metadata["render_modes"]
        self.render_mode = render_mode

        # Bullet ID counter ------------------------------------------------
        self._next_bullet_id = 0

        # State (populated by reset) --------------------------------------
        self._segments: list[tuple[float, float, float, float]] = []
        self._endpoints: list[tuple[float, float]] = []
        self._wall_lookup: dict[tuple[int, int], dict[str, bool]] = {}
        self._tanks: dict[int, dict[str, Any]] = {}
        self._prev_tanks: dict[int, dict[str, Any]] = {}
        self._bullets: list[dict[str, Any]] = []
        self._tick: int = 0
        self._last_fire_tick: dict[int, int] = {0: -999, 1: -999}

        self._tank_wall_normal: tuple[float, float] | None = None  # wall normal when agent hits
        self._ammo: list[int] = [self._phase_config.max_ammo_per_life, self._phase_config.max_ammo_per_life]
        self._episode_count: int = 0
        self._rng: np.random.Generator = np.random.default_rng()
        self._current_maze: dict[str, Any] | None = None
        self._bfs_follow_count: int = 0  # BFS follow reward counter per episode
        self._cached_bfs: tuple[float, float, float] | None = None  # cached per decision step
        self._last_firing_solution_segments: list[tuple[float, float, float, float]] = []
        self._last_firing_solution_hit: bool = False

    # ------------------------------------------------------------------
    # Reset
    # ------------------------------------------------------------------

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        self._rng = self.np_random
        self._episode_count += 1

        # Pick a random maze
        idx = int(self._rng.integers(0, len(self._mazes)))
        self._current_maze = self._mazes[idx]

        if self._phase_config.use_maze:
            self._load_maze(self._current_maze)
        else:
            self._load_open_arena()

        # Generate fresh spawn positions
        spawn1, spawn2 = _get_spawn_positions(
            self._current_maze["cols"], self._current_maze["rows"], self._rng,
            self._phase_config.spawn_distance_fraction,
        )

        self._tanks = {
            0: _make_tank(spawn1[0], spawn1[1], angle=float(self._rng.integers(0, 360))),
            1: _make_tank(spawn2[0], spawn2[1], angle=float(self._rng.integers(0, 360))),
        }
        self._prev_tanks = {
            0: dict(self._tanks[0]),
            1: dict(self._tanks[1]),
        }

        # Reset game state
        self._bullets = []
        self._next_bullet_id = 0
        self._tick = 0
        self._last_fire_tick = {0: -999, 1: -999}
        self._ammo = [self._phase_config.max_ammo_per_life, self._phase_config.max_ammo_per_life]
        self._tank_wall_normal = None
        self._bfs_follow_count = 0

        obs = self._get_observation(player=0)
        return obs, {}

    # ------------------------------------------------------------------
    # Maze loading
    # ------------------------------------------------------------------

    def _load_maze(self, maze: dict[str, Any]) -> None:
        """Parse a pre-generated maze dict into internal state."""
        self._segments = [
            (s["x1"], s["y1"], s["x2"], s["y2"]) for s in maze["segments"]
        ]
        self._endpoints = [(e["x"], e["y"]) for e in maze["endpoints"]]
        self._wall_lookup = self._build_wall_lookup(maze["walls"])

    def _load_open_arena(self) -> None:
        """Phase 0: no internal walls, only border segments."""
        # Border segments (top, bottom, left, right)
        self._segments = [
            (0, 0, ARENA_W, 0),       # top
            (0, ARENA_H, ARENA_W, ARENA_H),  # bottom
            (0, 0, 0, ARENA_H),       # left
            (ARENA_W, 0, ARENA_W, ARENA_H),  # right
        ]
        self._endpoints = []
        self._wall_lookup = {}

    # ------------------------------------------------------------------
    # Wall lookup builder
    # ------------------------------------------------------------------

    @staticmethod
    def _build_wall_lookup(
        walls: list[dict[str, Any]],
    ) -> dict[tuple[int, int], dict[str, bool]]:
        """Build a {(row, col): {"top": bool, "right": bool}} lookup.

        Uses the raw wall list from the maze generator (pre-merge,
        pre-filter) so that ALL cell-edge walls are represented.
        """
        lookup: dict[tuple[int, int], dict[str, bool]] = {}

        for w in walls:
            axis = w["axis"]
            from_row = w["fromRow"]
            from_col = w["fromCol"]
            to_row = w["toRow"]
            to_col = w["toCol"]

            if axis == "v":
                r, c = from_row, min(from_col, to_col)
                if (r, c) not in lookup:
                    lookup[(r, c)] = {"top": False, "right": False}
                lookup[(r, c)]["right"] = True
            elif axis == "h":
                r, c = max(from_row, to_row), from_col
                if (r, c) not in lookup:
                    lookup[(r, c)] = {"top": False, "right": False}
                lookup[(r, c)]["top"] = True

        return lookup

    def _can_move(self, row: int, col: int, direction: str) -> bool:
        """Check if a tank can move from (row, col) in the given direction."""
        if direction == "up":
            if row == 0:
                return False
            return not self._has_wall(row, col, "top")
        elif direction == "down":
            if row >= MAZE_ROWS - 1:
                return False
            return not self._has_wall(row + 1, col, "top")
        elif direction == "left":
            if col == 0:
                return False
            return not self._has_wall(row, col - 1, "right")
        elif direction == "right":
            if col >= MAZE_COLS - 1:
                return False
            return not self._has_wall(row, col, "right")
        return False

    def _bfs_path_direction(
        self, ego_x: float, ego_y: float, opp_x: float, opp_y: float
    ) -> tuple[float, float, float]:
        """BFS shortest path using a sub-grid for finer direction signals.

        Each maze cell is subdivided into BFS_SUB_GRID x BFS_SUB_GRID sub-cells
        (3x3 = 27x18 grid vs original 9x6). Movement within a maze cell is free;
        crossing a maze cell boundary checks the wall lookup.

        Accepts pixel coordinates directly.

        Returns (cos_dir, sin_dir, norm_distance):
          - cos_dir, sin_dir: direction to the next sub-cell on the path (world frame).
          - norm_distance: BFS path length / max possible sub-cells, in [0, 1].
        """
        sub_size = CELL_SIZE / BFS_SUB_GRID
        total_sr = MAZE_ROWS * BFS_SUB_GRID
        total_sc = MAZE_COLS * BFS_SUB_GRID

        ego_sr = min(max(int(ego_y / sub_size), 0), total_sr - 1)
        ego_sc = min(max(int(ego_x / sub_size), 0), total_sc - 1)
        opp_sr = min(max(int(opp_y / sub_size), 0), total_sr - 1)
        opp_sc = min(max(int(opp_x / sub_size), 0), total_sc - 1)

        if ego_sr == opp_sr and ego_sc == opp_sc:
            return (0.0, 0.0, 0.0)

        start = (ego_sr, ego_sc)
        goal = (opp_sr, opp_sc)
        visited: set[tuple[int, int]] = {start}
        parent: dict[tuple[int, int], tuple[int, int]] = {}
        queue: deque[tuple[int, int]] = deque([start])

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
                # Check wall only when crossing a maze cell boundary
                maze_r1 = sr // BFS_SUB_GRID
                maze_c1 = sc // BFS_SUB_GRID
                maze_r2 = nsr // BFS_SUB_GRID
                maze_c2 = nsc // BFS_SUB_GRID
                if maze_r1 != maze_r2 or maze_c1 != maze_c2:
                    if dr == -1 and not self._can_move(maze_r1, maze_c1, "up"):
                        continue
                    if dr == 1 and not self._can_move(maze_r1, maze_c1, "down"):
                        continue
                    if dc == -1 and not self._can_move(maze_r1, maze_c1, "left"):
                        continue
                    if dc == 1 and not self._can_move(maze_r1, maze_c1, "right"):
                        continue
                visited.add((nsr, nsc))
                parent[(nsr, nsc)] = (sr, sc)
                queue.append((nsr, nsc))

        if goal not in parent:
            return (0.0, 0.0, 1.0)  # unreachable

        # Walk back from goal to find the sub-cell right after start
        cell = goal
        path_len = 0
        while parent.get(cell) != start:
            cell = parent[cell]
            path_len += 1
        path_len += 1

        next_sr, next_sc = cell
        target_x = next_sc * sub_size + sub_size / 2
        target_y = next_sr * sub_size + sub_size / 2
        dx = target_x - ego_x
        dy = target_y - ego_y
        dist = math.hypot(dx, dy)
        if dist == 0:
            return (0.0, 0.0, 0.0)

        world_angle = math.atan2(dy, dx)
        max_path = total_sr * total_sc
        norm_dist = min(path_len / max_path, 1.0)

        return (math.cos(world_angle), math.sin(world_angle), norm_dist)

    def _has_wall(self, row: int, col: int, side: str) -> bool:
        """Check if a cell has a wall on the given side ('top' or 'right').

        Border edges are implicitly walls.
        """
        if side == "top" and row == 0:
            return True
        if side == "right" and col == MAZE_COLS - 1:
            return True
        cell = self._wall_lookup.get((row, col))
        if cell is None:
            return False
        return cell.get(side, False)

    # ------------------------------------------------------------------
    # New round (between rounds within a game)
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Action decoding
    # ------------------------------------------------------------------

    def _decode_action(self, action: int) -> dict[str, bool]:
        """Map int action -> InputState dict using the action_table module."""
        return decode_action(action)

    def _load_opponent_model(self, model_path: str) -> None:
        """Load a trained PPO model to use as the opponent."""
        from ppo import ActorCritic

        state_dim = self.observation_space.shape[0]
        action_dim = self.action_space.n
        self._opponent_device = "cpu"
        state_dict = torch.load(model_path, map_location=self._opponent_device, weights_only=True)
        # Detect architecture from state dict keys
        separate = "actor_net.0.weight" in state_dict
        if separate:
            hidden_dim = state_dict["actor_net.0.weight"].shape[0]
        else:
            hidden_dim = state_dict["shared.0.weight"].shape[0]
        self._opponent_model = ActorCritic(
            state_dim, action_dim, hidden_dim=hidden_dim, separate=separate
        )
        self._opponent_model.load_state_dict(state_dict)
        self._opponent_model.eval()

    def _get_opponent_action(self) -> dict[str, bool]:
        """Return opponent's action -- self-play if model loaded, else random."""
        if self._opponent_model is not None:
            obs = self._get_observation(player=1)
            with torch.no_grad():
                obs_t = torch.tensor(obs, dtype=torch.float32, device=self._opponent_device).unsqueeze(0)
                logits, _ = self._opponent_model(obs_t)
                action_idx = int(logits.argmax(dim=1).item())
            result = decode_action(action_idx)
        else:
            action_idx = int(self._rng.integers(0, 18))
            result = decode_action(action_idx)
            # Throttle random opponent firing based on phase config
            if self._phase_config.opp_fire_cooldown_ticks > 0:
                ticks_since_fire = self._tick - self._last_fire_tick[1]
                if result["fire"] and ticks_since_fire < self._phase_config.opp_fire_cooldown_ticks:
                    result["fire"] = False

        # Strip fire if phase config disables opponent shooting
        if not self._phase_config.opponent_can_fire:
            result["fire"] = False

        # Stationary opponent: zero all movement
        if self._phase_config.opponent_stationary:
            result["up"] = False
            result["down"] = False
            result["left"] = False
            result["right"] = False

        return result

    # ------------------------------------------------------------------
    # Can fire check
    # ------------------------------------------------------------------

    def _can_fire(self, player_id: int) -> bool:
        """Check if player can fire (cooldown elapsed + under max bullet count + has ammo)."""
        ticks_since_fire = self._tick - self._last_fire_tick[player_id]
        bullet_count = sum(1 for b in self._bullets if b["owner"] == player_id)
        return (
            ticks_since_fire >= FIRE_COOLDOWN_TICKS
            and bullet_count < MAX_BULLETS
            and self._ammo[player_id] > 0
        )

    # ------------------------------------------------------------------
    # Movement + Clamping
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_obb(angle: float) -> tuple[float, float]:
        """Port of computeTankOBB() from physics.ts."""
        rad = math.radians(angle)
        cos_a = abs(math.cos(rad))
        sin_a = abs(math.sin(rad))
        obb = (TANK_WIDTH / 2) * (cos_a + sin_a)
        return (rad, obb)

    def _clamp_tank_to_maze(self, tank: dict[str, Any]) -> None:
        """Port of clampTankToMaze() from physics.ts."""
        rad, obb = self._compute_obb(tank["angle"])
        barrel_tip_dist = BARREL_LENGTH + TANK_WIDTH / 2
        barrel_x = barrel_tip_dist * math.cos(rad)
        barrel_y = barrel_tip_dist * math.sin(rad)
        right_extent = max(obb, barrel_x if barrel_x > 0 else 0)
        left_extent = max(obb, -barrel_x if barrel_x < 0 else 0)
        bottom_extent = max(obb, barrel_y if barrel_y > 0 else 0)
        top_extent = max(obb, -barrel_y if barrel_y < 0 else 0)

        tank["x"] = max(left_extent, min(tank["x"], ARENA_W - right_extent))
        tank["y"] = max(top_extent, min(tank["y"], ARENA_H - bottom_extent))

    # ------------------------------------------------------------------
    # Wall Collision (AABB)
    # ------------------------------------------------------------------

    def _collide_tank_walls(
        self, tank: dict[str, Any], prev_tank: dict[str, Any]
    ) -> tuple[float, float] | None:
        """AABB simplified: treat tank as axis-aligned square.

        Returns the wall normal (nx, ny) of the last wall hit, or None if no hit.
        """
        half = TANK_WIDTH // 2
        normal: tuple[float, float] | None = None
        for seg in self._segments:
            x1, y1, x2, y2 = seg
            is_h = y1 == y2
            is_v = x1 == x2
            if is_h:
                wall_y = y1
                min_x = min(x1, x2)
                max_x = max(x1, x2)
                if min_x - half < tank["x"] < max_x + half:
                    if abs(tank["y"] - wall_y) < half:
                        if prev_tank["y"] < wall_y:
                            tank["y"] = wall_y - half
                            normal = (0.0, -1.0)
                        else:
                            tank["y"] = wall_y + half
                            normal = (0.0, 1.0)
            elif is_v:
                wall_x = x1
                min_y = min(y1, y2)
                max_y = max(y1, y2)
                if min_y - half < tank["y"] < max_y + half:
                    if abs(tank["x"] - wall_x) < half:
                        if prev_tank["x"] < wall_x:
                            tank["x"] = wall_x - half
                            normal = (-1.0, 0.0)
                        else:
                            tank["x"] = wall_x + half
                            normal = (1.0, 0.0)
        return normal

    def _collide_tank_with_endpoints(self, tank: dict[str, Any]) -> bool:
        """Port of collideTankWithEndpoints() from physics.ts."""
        _, obb = self._compute_obb(tank["angle"])
        shield_radius = obb + CORNER_SHIELD_PADDING
        hit = False

        for pt in self._endpoints:
            dx = tank["x"] - pt[0]
            dy = tank["y"] - pt[1]
            dist_sq = dx * dx + dy * dy
            if dist_sq < shield_radius * shield_radius and dist_sq > 0:
                dist = math.sqrt(dist_sq)
                nx = dx / dist
                ny = dy / dist
                tank["x"] = pt[0] + nx * shield_radius
                tank["y"] = pt[1] + ny * shield_radius
                hit = True
        return hit

    # ------------------------------------------------------------------
    # Bullets
    # ------------------------------------------------------------------

    def _bullet_crosses_wall(
        self,
        prev_x: float,
        prev_y: float,
        next_x: float,
        next_y: float,
        seg: tuple[float, float, float, float],
    ) -> tuple[bool, float, float]:
        """Port of physics.ts bulletCrossesWall(). Returns (crossed, hitX, hitY)."""
        sx1, sy1, sx2, sy2 = seg

        if sx1 == sx2:
            wx = sx1
            min_y = min(sy1, sy2)
            max_y = max(sy1, sy2)
            if min(prev_x, next_x) <= wx <= max(prev_x, next_x):
                dx = next_x - prev_x
                if abs(dx) < 0.001:
                    return (False, 0.0, 0.0)
                t = (wx - prev_x) / dx
                hit_y = prev_y + t * (next_y - prev_y)
                if min_y <= hit_y <= max_y:
                    return (True, wx, hit_y)
        elif sy1 == sy2:
            wy = sy1
            min_x = min(sx1, sx2)
            max_x = max(sx1, sx2)
            if min(prev_y, next_y) <= wy <= max(prev_y, next_y):
                dy = next_y - prev_y
                if abs(dy) < 0.001:
                    return (False, 0.0, 0.0)
                t = (wy - prev_y) / dy
                hit_x = prev_x + t * (next_x - prev_x)
                if min_x <= hit_x <= max_x:
                    return (True, hit_x, wy)

        return (False, 0.0, 0.0)

    def _create_bullet(
        self, owner_id: int, tank: dict[str, Any]
    ) -> dict[str, Any]:
        """Port of physics.ts createBullet(): spawn bullet at barrel tip."""
        rad = math.radians(tank["angle"])
        spawn_dist = BARREL_LENGTH + TANK_WIDTH / 2
        tip_x = tank["x"] + math.cos(rad) * spawn_dist
        tip_y = tank["y"] + math.sin(rad) * spawn_dist
        vx = math.cos(rad) * BULLET_SPEED
        vy = math.sin(rad) * BULLET_SPEED

        bullet_id = self._next_bullet_id
        self._next_bullet_id += 1

        for seg in self._segments:
            crossed, hit_x, hit_y = self._bullet_crosses_wall(
                tank["x"], tank["y"], tip_x, tip_y, seg
            )
            if crossed:
                bullet = {
                    "id": bullet_id,
                    "owner": owner_id,
                    "x": tip_x,
                    "y": tip_y,
                    "vx": vx,
                    "vy": vy,
                    "age": 0.0,
                    "bounces": 1,
                    "reflected_at_spawn": True,
                }
                return self._reflect_bullet_at_wall(bullet, seg, hit_x, hit_y)

        return {
            "id": bullet_id,
            "owner": owner_id,
            "x": tip_x,
            "y": tip_y,
            "vx": vx,
            "vy": vy,
            "age": 0.0,
            "bounces": 0,
            "reflected_at_spawn": False,
        }

    def _reflect_bullet_at_wall(
        self,
        bullet: dict[str, Any],
        seg: tuple[float, float, float, float],
        hit_x: float,
        hit_y: float,
    ) -> dict[str, Any]:
        """Port of physics.ts reflectBulletAtWall()."""
        sx1, sy1, sx2, sy2 = seg
        vx = bullet["vx"]
        vy = bullet["vy"]
        x = hit_x
        y = hit_y
        eps = BULLET_RADIUS + BULLET_WALL_CLEARANCE

        if sx1 == sx2:
            vx = -vx
            x = hit_x + eps if vx > 0 else hit_x - eps
        elif sy1 == sy2:
            vy = -vy
            y = hit_y + eps if vy > 0 else hit_y - eps

        bullet["x"] = x
        bullet["y"] = y
        bullet["vx"] = vx
        bullet["vy"] = vy
        return bullet

    def _reflect_bullet(
        self,
        bullet: dict[str, Any],
        prev_x: float,
        prev_y: float,
    ) -> None:
        """Port of physics.ts advanceBullet() wall reflection logic."""
        for seg in self._segments:
            crossed, hit_x, hit_y = self._bullet_crosses_wall(
                prev_x, prev_y, bullet["x"], bullet["y"], seg
            )
            if crossed:
                dx_total = bullet["x"] - prev_x
                dy_total = bullet["y"] - prev_y
                total_dist = math.sqrt(dx_total * dx_total + dy_total * dy_total)

                self._reflect_bullet_at_wall(bullet, seg, hit_x, hit_y)
                bullet["bounces"] += 1

                if total_dist > 0.001:
                    hit_dx = hit_x - prev_x
                    hit_dy = hit_y - prev_y
                    hit_dist = math.sqrt(hit_dx * hit_dx + hit_dy * hit_dy)
                    remain_dist = total_dist - hit_dist
                    speed = math.sqrt(
                        bullet["vx"] * bullet["vx"] + bullet["vy"] * bullet["vy"]
                    )
                    if speed > 0:
                        bullet["x"] += (bullet["vx"] / speed) * remain_dist
                        bullet["y"] += (bullet["vy"] / speed) * remain_dist

                return

    def _check_bullet_tank_hit(
        self,
        bullet: dict[str, Any],
        tank: dict[str, Any],
        prev_bullet_x: float,
        prev_bullet_y: float,
    ) -> bool:
        """AABB simplified: circle vs axis-aligned square + wall occlusion check."""
        dx = abs(bullet["x"] - tank["x"])
        dy = abs(bullet["y"] - tank["y"])
        half = TANK_WIDTH // 2 - TANK_HITBOX_SHRINK
        r = BULLET_HIT_RADIUS

        if dx <= half + r and dy <= half + r:
            if self._line_segment_crosses_any_wall(
                bullet["x"], bullet["y"], tank["x"], tank["y"]
            ):
                return False
            return True

        min_x = tank["x"] - half
        max_x = tank["x"] + half
        min_y = tank["y"] - half
        max_y = tank["y"] + half
        if self._segment_aabb_intersects(
            prev_bullet_x, prev_bullet_y, bullet["x"], bullet["y"],
            min_x, min_y, max_x, max_y,
        ):
            if self._line_segment_crosses_any_wall(
                bullet["x"], bullet["y"], tank["x"], tank["y"]
            ):
                return False
            return True

        return False

    @staticmethod
    def _segment_aabb_intersects(
        x0: float, y0: float, x1: float, y1: float,
        min_x: float, min_y: float, max_x: float, max_y: float,
    ) -> bool:
        """Liang-Barsky segment vs AABB intersection test."""
        dx = x1 - x0
        dy = y1 - y0
        t_min = 0.0
        t_max = 1.0

        p = [-dx, dx, -dy, dy]
        q = [x0 - min_x, max_x - x0, y0 - min_y, max_y - y0]

        for i in range(4):
            if abs(p[i]) < 1e-10:
                if q[i] < 0:
                    return False
            else:
                t = q[i] / p[i]
                if p[i] < 0:
                    t_min = max(t_min, t)
                else:
                    t_max = min(t_max, t)
                if t_min > t_max:
                    return False

        return True

    def _line_segment_crosses_any_wall(
        self, x1: float, y1: float, x2: float, y2: float
    ) -> bool:
        """Check if line segment crosses any wall (for wall occlusion)."""
        for seg in self._segments:
            if self._segments_intersect(
                x1, y1, x2, y2, seg[0], seg[1], seg[2], seg[3]
            ):
                return True
        return False

    def _raycast_wall_distance(
        self, x: float, y: float, angle_deg: float, max_dist: float
    ) -> float:
        """Cast a ray and return distance to nearest wall hit (or max_dist)."""
        rad = math.radians(angle_deg)
        dx = math.cos(rad)
        dy = math.sin(rad)
        best = max_dist
        for seg in self._segments:
            t = self._ray_segment_intersect(
                x, y, dx, dy, seg[0], seg[1], seg[2], seg[3]
            )
            if t is not None and t < best:
                best = t
        return best

    @staticmethod
    def _ray_segment_intersect(
        ox: float, oy: float, dx: float, dy: float,
        sx1: float, sy1: float, sx2: float, sy2: float,
    ) -> float | None:
        """Return distance along ray (ox,oy)->(dx,dy) to segment, or None."""
        dsx = sx2 - sx1
        dsy = sy2 - sy1
        denom = dx * dsy - dy * dsx
        if abs(denom) < 1e-10:
            return None
        t = ((sx1 - ox) * dsy - (sy1 - oy) * dsx) / denom
        u = ((sx1 - ox) * dy - (sy1 - oy) * dx) / denom
        if t >= 0 and 0 <= u <= 1:
            return t
        return None

    @staticmethod
    def _segments_intersect(
        ax1: float, ay1: float, ax2: float, ay2: float,
        bx1: float, by1: float, bx2: float, by2: float,
    ) -> bool:
        """Check if line segment A crosses segment B using cross products."""

        def cross(
            ox: float, oy: float, px: float, py: float, qx: float, qy: float
        ) -> float:
            return (px - ox) * (qy - oy) - (py - oy) * (qx - ox)

        d1 = cross(bx1, by1, bx2, by2, ax1, ay1)
        d2 = cross(bx1, by1, bx2, by2, ax2, ay2)
        d3 = cross(ax1, ay1, ax2, ay2, bx1, by1)
        d4 = cross(ax1, ay1, ax2, ay2, bx2, by2)

        if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and (
            (d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)
        ):
            return True
        return False

    # ------------------------------------------------------------------
    # Physics tick
    # ------------------------------------------------------------------

    def _physics_tick(
        self,
        agent_input: dict[str, bool],
        opponent_input: dict[str, bool],
    ) -> tuple[float, list[dict[str, int]]]:
        """Single physics tick at 60Hz. Mirrors BaseTankRoom tick logic.

        Returns:
            (tick_reward, kill_events)
        """
        cfg = self._phase_config
        dt = PHYSICS_STEP
        reward = 0.0
        kill_events: list[dict[str, int]] = []

        # --- 1. Update tanks ---
        inputs = {0: agent_input, 1: opponent_input}
        self._tank_wall_normal = None

        for pid in [0, 1]:
            tank = self._tanks[pid]
            if not tank["alive"]:
                continue
            inp = inputs[pid]

            self._prev_tanks[pid] = dict(tank)

            # Rotation
            if inp["left"]:
                tank["angle"] -= TANK_ROTATION_SPEED * dt
            if inp["right"]:
                tank["angle"] += TANK_ROTATION_SPEED * dt
            tank["angle"] = tank["angle"] % 360.0

            # Movement
            speed = 0.0
            if inp["up"]:
                speed = TANK_SPEED
            elif inp["down"]:
                speed = -TANK_SPEED * REVERSE_SPEED_FACTOR
            tank["speed"] = speed

            rad = math.radians(tank["angle"])
            tank["x"] += math.cos(rad) * speed * dt
            tank["y"] += math.sin(rad) * speed * dt

            # Clamp -> wall collision -> endpoint collision
            self._clamp_tank_to_maze(tank)
            wall_normal = self._collide_tank_walls(tank, self._prev_tanks[pid])
            endpoint_hit = self._collide_tank_with_endpoints(tank)
            if pid == 0 and (wall_normal is not None or endpoint_hit):
                self._tank_wall_normal = wall_normal or (0.0, 0.0)

            tank["x"] = float(np.float32(tank["x"]))
            tank["y"] = float(np.float32(tank["y"]))
            tank["angle"] = float(np.float32(tank["angle"]))

        # --- 2. Handle firing ---
        for pid in [0, 1]:
            tank = self._tanks[pid]
            if not tank["alive"] or not inputs[pid]["fire"]:
                continue
            if self._can_fire(pid):
                bullet = self._create_bullet(pid, tank)
                self._bullets.append(bullet)
                self._last_fire_tick[pid] = self._tick
                self._ammo[pid] -= 1
                if pid == 0:
                    opp = self._tanks[1]
                    if opp["alive"] and not bullet["reflected_at_spawn"]:
                        has_wall_between = self._line_segment_crosses_any_wall(
                            tank["x"], tank["y"], opp["x"], opp["y"]
                        )
                        # Firing solution reward: trace predicted a hit (incl. bounces)
                        if self._last_firing_solution_hit:
                            reward += cfg.reward_firing_solution_hit
                        # Good aim: cos similarity, only with clear LOS
                        if not has_wall_between:
                            cos_aim = self._bullet_heading_toward(
                                opp["x"], opp["y"],
                                bullet["x"], bullet["y"],
                                bullet["vx"], bullet["vy"],
                            )
                            reward += cfg.reward_good_aim * max(0.0, cos_aim)
                        # Wasted shot: no LOS and trace says miss
                        if has_wall_between and not self._last_firing_solution_hit:
                            reward += cfg.reward_wasted_shot

        # --- 3. Update bullets ---
        bullets_to_remove: list[int] = []
        for i, bullet in enumerate(self._bullets):
            prev_x = bullet["x"]
            prev_y = bullet["y"]

            bullet["x"] += bullet["vx"] * dt
            bullet["y"] += bullet["vy"] * dt
            bullet["age"] += dt

            if bullet["age"] >= BULLET_LIFETIME:
                bullets_to_remove.append(i)
                continue

            self._reflect_bullet(bullet, prev_x, prev_y)

            for pid in [0, 1]:
                tank = self._tanks[pid]
                if not tank["alive"]:
                    continue
                if bullet["owner"] == pid:
                    # Self-damage check: agent uses self_damage_prob, opponent uses opp_self_damage
                    if pid == 0:
                        if self._phase_config.self_damage_prob <= 0.0:
                            continue
                        if self._phase_config.self_damage_prob < 1.0 and self._rng.random() > self._phase_config.self_damage_prob:
                            continue
                    else:
                        if not self._phase_config.opp_self_damage:
                            continue
                if self._check_bullet_tank_hit(bullet, tank, prev_x, prev_y):
                    tank["alive"] = False
                    bullets_to_remove.append(i)
                    kill_events.append({"killed": pid, "killer": bullet["owner"], "bounces": bullet["bounces"]})
                    break

        for i in sorted(set(bullets_to_remove), reverse=True):
            self._bullets.pop(i)

        # --- 4. Dense shaping rewards (agent = player 0) ---
        reward += self._compute_shaping_reward()

        return reward, kill_events

    # ------------------------------------------------------------------
    # Step with kill/tie/round/game logic
    # ------------------------------------------------------------------

    def step(
        self, action: int
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        """Execute one decision step (3 physics ticks at 60Hz = 20Hz decisions)."""
        cfg = self._phase_config
        agent_input = self._decode_action(action)
        opponent_input = self._get_opponent_action()

        # Cache BFS once per decision step (used in shaping reward + observation)
        ego = self._tanks[0]
        opp = self._tanks[1]
        if opp["alive"] and self._phase_config.use_maze:
            self._cached_bfs = self._bfs_path_direction(
                ego["x"], ego["y"], opp["x"], opp["y"]
            )
        else:
            self._cached_bfs = None

        reward = 0.0
        terminated = False
        truncated = False

        for _ in range(DECISION_INTERVAL):
            tick_reward, kill_events = self._physics_tick(
                agent_input, opponent_input
            )
            reward += tick_reward
            self._tick += 1

            for kill_event in kill_events:
                killed = kill_event["killed"]
                killer = kill_event["killer"]

                if killer == 0 and killed == 1:
                    reward += cfg.reward_kill
                if killed == 0:
                    reward += cfg.reward_death

                # Any death = episode over (1 life each)
                terminated = True
                break

            if terminated:
                break

            if self._tick >= cfg.max_episode_ticks:
                truncated = True
                break

        obs = self._get_observation(player=0)
        info: dict[str, Any] = {}
        if terminated:
            # Opponent died = win
            info["win"] = not self._tanks[1]["alive"]
        if truncated:
            info["win"] = False
        return obs, reward, terminated, truncated, info

    # ------------------------------------------------------------------
    # Observation encoding
    # ------------------------------------------------------------------

    @staticmethod
    def _cos_angle_between(
        from_x: float, from_y: float, angle_rad: float,
        to_x: float, to_y: float,
    ) -> float:
        """Cosine of angle between a facing direction and the vector to a target."""
        dx = to_x - from_x
        dy = to_y - from_y
        d = math.hypot(dx, dy)
        if d == 0:
            return 0.0
        return (math.cos(angle_rad) * dx + math.sin(angle_rad) * dy) / d

    @staticmethod
    def _bullet_heading_toward(
        ego_x: float, ego_y: float,
        bx: float, by: float, bvx: float, bvy: float,
    ) -> float:
        """Cosine between bullet velocity and bullet→ego vector.

        +1 = heading straight at ego, -1 = heading away.
        """
        dx = ego_x - bx
        dy = ego_y - by
        d = math.hypot(dx, dy)
        if d == 0:
            return 0.0
        bspd = math.hypot(bvx, bvy)
        if bspd == 0:
            return 0.0
        return (bvx * dx + bvy * dy) / (bspd * d)

    @staticmethod
    def _point_to_segment_distance(
        px: float, py: float,
        ax: float, ay: float, bx: float, by: float,
    ) -> float:
        """Minimum distance from point (px,py) to line segment (ax,ay)-(bx,by)."""
        abx = bx - ax
        aby = by - ay
        apx = px - ax
        apy = py - ay
        ab_sq = abx * abx + aby * aby
        if ab_sq < 1e-12:
            return math.hypot(apx, apy)
        t = (apx * abx + apy * aby) / ab_sq
        t = max(0.0, min(1.0, t))
        proj_x = ax + t * abx
        proj_y = ay + t * aby
        return math.hypot(px - proj_x, py - proj_y)

    def _trace_firing_solution(
        self, player: int
    ) -> tuple[float, float, float, list[tuple[float, float, float, float]]]:
        """Trace hypothetical bullet from barrel, bouncing off walls.

        Returns (would_hit_opp, norm_distance, would_hit_self, path_segments_for_debug).
        Checks both opponent and self-hit in a single pass.
        """
        ego = self._tanks[player]
        opp = self._tanks[1 - player]

        if not ego["alive"] or not opp["alive"]:
            self._last_firing_solution_segments = []
            self._last_firing_solution_hit = False
            return (0.0, 0.0, 0.0, [])

        rad = math.radians(ego["angle"])
        cos_a = math.cos(rad)
        sin_a = math.sin(rad)
        spawn_dist = BARREL_LENGTH + TANK_WIDTH / 2
        x = ego["x"] + cos_a * spawn_dist
        y = ego["y"] + sin_a * spawn_dist
        vx = cos_a
        vy = sin_a

        # Check if barrel tip spawns through a wall (same as _create_bullet)
        spawned_through_wall = False
        for seg in self._segments:
            crossed, hit_x, hit_y = self._bullet_crosses_wall(
                ego["x"], ego["y"], x, y, seg
            )
            if crossed:
                sx1, sy1, sx2, sy2 = seg
                eps = BULLET_RADIUS + BULLET_WALL_CLEARANCE
                if sx1 == sx2:
                    vx = -vx
                    x = hit_x + eps if vx > 0 else hit_x - eps
                    y = hit_y
                elif sy1 == sy2:
                    vy = -vy
                    x = hit_x
                    y = hit_y + eps if vy > 0 else hit_y - eps
                spawned_through_wall = True
                break

        max_travel = BULLET_SPEED * BULLET_LIFETIME
        hit_radius = BULLET_HIT_RADIUS + TANK_WIDTH // 2 - TANK_HITBOX_SHRINK
        total_dist = 0.0
        segments: list[tuple[float, float, float, float]] = []
        found_opp_hit = False
        opp_norm_dist = 0.0
        found_self_hit = False
        # Skip self-hit check on first segment (bullet moving away from ego)
        # unless it spawned through a wall (reflected back toward ego)
        bounce_count = 1 if spawned_through_wall else 0

        for _ in range(MAX_BULLET_BOUNCES):
            # Find nearest wall hit along current ray direction
            best_t = float("inf")
            best_seg: tuple[float, float, float, float] | None = None
            for seg in self._segments:
                t = self._ray_segment_intersect(
                    x, y, vx, vy, seg[0], seg[1], seg[2], seg[3]
                )
                if t is not None and t > 0.5 and t < best_t:
                    best_t = t
                    best_seg = seg

            # Clamp to remaining bullet range
            remaining = max_travel - total_dist
            if remaining <= 0:
                break
            seg_len = min(best_t, remaining) if best_t < float("inf") else remaining
            end_x = x + vx * seg_len
            end_y = y + vy * seg_len
            segments.append((x, y, end_x, end_y))

            # Check if opponent is within hit_radius of this segment
            if not found_opp_hit:
                dist = self._point_to_segment_distance(
                    opp["x"], opp["y"], x, y, end_x, end_y
                )
                if dist < hit_radius:
                    found_opp_hit = True
                    opp_norm_dist = min((total_dist + seg_len) / max_travel, 1.0)
                    break  # bullet is destroyed on opponent hit — stop tracing

            # Check if ego is within hit_radius (only after a bounce)
            if not found_self_hit and bounce_count >= 1:
                self_dist = self._point_to_segment_distance(
                    ego["x"], ego["y"], x, y, end_x, end_y
                )
                if self_dist < hit_radius:
                    found_self_hit = True
                    break  # found self-hit — stop tracing

            total_dist += seg_len
            if total_dist >= max_travel:
                break

            # No wall hit within range — ray goes to infinity
            if best_seg is None or best_t >= remaining:
                break

            # Reflect off wall
            sx1, sy1, sx2, sy2 = best_seg
            wall_x = x + vx * best_t
            wall_y = y + vy * best_t
            eps = BULLET_RADIUS + BULLET_WALL_CLEARANCE
            if sx1 == sx2:  # vertical wall
                vx = -vx
                x = wall_x + eps if vx > 0 else wall_x - eps
                y = wall_y
            elif sy1 == sy2:  # horizontal wall
                vy = -vy
                x = wall_x
                y = wall_y + eps if vy > 0 else wall_y - eps
            else:
                break  # non-axis-aligned wall, shouldn't happen
            bounce_count += 1

        self._last_firing_solution_segments = segments
        self._last_firing_solution_hit = found_opp_hit
        return (
            1.0 if found_opp_hit else 0.0,
            opp_norm_dist,
            1.0 if found_self_hit else 0.0,
            segments,
        )

    def _get_observation(self, player: int) -> np.ndarray:
        """Encode game state from the perspective of `player` (ego-centric).

        Returns float32[148] vector, all values clipped to [-1, 1].

        Layout:
          [0..6]     Ego tank              (7 values)
          [7..14]    Opponent (ego-centric) (8 values)
          [15..16]   Lives                  (2 values)
          [17..52]   Bullets                (6 slots x 6 values = 36)
          [53..102]  Local wall grid        (5x5 x 2 = 50 values)
          [103..105] Metadata               (3 values)
          [106..107] LOS to opponent        (2 values)
          [108..119] Wall raycasts 12 dirs  (12 values)
          [120..122] BFS compass            (3 values)
          [123..125] BFS turn hint          (3 values: one-hot [left, straight, right])
          [126..127] Aim alignment          (2 values)
          [128..130] Lead angle             (3 values)
          [131..132] Shot difficulty         (2 values)
          [133..136] Threat awareness       (4 values: count, nearest dist, nearest angle cos/sin)
          [137..140] Self-bullet threat     (4 values: count, nearest dist, nearest angle cos/sin)
          [141..142] Tactical               (2 values: time since fired, opp facing me)
          [143]      Barrel wall distance   (1 value)
          [144..146] Firing solution        (3 values: shot_would_hit, shot_hit_distance, shot_would_hit_self)
          [147]      Ammo fraction          (1 value: remaining ammo / max ammo per life)
        """
        ego = self._tanks[player]
        opp = self._tanks[1 - player]
        ego_rad = math.radians(ego["angle"])
        cos_ego = math.cos(ego_rad)
        sin_ego = math.sin(ego_rad)
        obs: list[float] = []

        # --- Ego tank (7 values) [0..6] ---
        obs.append(ego["x"] / ARENA_W)
        obs.append(ego["y"] / ARENA_H)
        obs.append(cos_ego)
        obs.append(sin_ego)
        obs.append(ego["speed"] / TANK_SPEED)
        obs.append(1.0 if ego["alive"] else 0.0)
        obs.append(1.0 if self._can_fire(player) else 0.0)

        # --- Opponent (ego-centric) (8 values) [7..14] ---
        # Relative position rotated into ego's frame
        rel_x_world = opp["x"] - ego["x"]
        rel_y_world = opp["y"] - ego["y"]
        # Rotate into ego frame: [cos -sin; sin cos]^T * [dx, dy]
        rel_x_ego = rel_x_world * cos_ego + rel_y_world * sin_ego
        rel_y_ego = -rel_x_world * sin_ego + rel_y_world * cos_ego
        max_dist = math.hypot(ARENA_W, ARENA_H)
        obs.append(rel_x_ego / max_dist)
        obs.append(rel_y_ego / max_dist)
        # Relative angle
        rel_angle = opp["angle"] - ego["angle"]
        obs.append(math.cos(math.radians(rel_angle)))
        obs.append(math.sin(math.radians(rel_angle)))
        obs.append(opp["speed"] / TANK_SPEED)
        obs.append(1.0 if opp["alive"] else 0.0)
        # Bearing to opponent (already in ego frame from rel pos)
        bearing_rad = math.atan2(rel_y_ego, rel_x_ego)
        obs.append(math.cos(bearing_rad))
        obs.append(math.sin(bearing_rad))

        # --- Bullets (6 closest slots x 6 values = 36) [15..50] ---
        bullet_data: list[tuple[float, dict[str, Any]]] = []
        for b in self._bullets:
            dist = math.hypot(b["x"] - ego["x"], b["y"] - ego["y"])
            bullet_data.append((dist, b))
        bullet_data.sort(key=lambda x: x[0])

        for i in range(BULLET_OBS_SLOTS):
            if i < len(bullet_data):
                _, b = bullet_data[i]
                # Rotate bullet position into ego frame
                b_rel_x = b["x"] - ego["x"]
                b_rel_y = b["y"] - ego["y"]
                b_ego_x = b_rel_x * cos_ego + b_rel_y * sin_ego
                b_ego_y = -b_rel_x * sin_ego + b_rel_y * cos_ego
                obs.append(b_ego_x / max_dist)
                obs.append(b_ego_y / max_dist)
                # Rotate bullet velocity into ego frame
                b_vx_ego = b["vx"] * cos_ego + b["vy"] * sin_ego
                b_vy_ego = -b["vx"] * sin_ego + b["vy"] * cos_ego
                obs.append(b_vx_ego / BULLET_SPEED)
                obs.append(b_vy_ego / BULLET_SPEED)
                obs.append(1.0 if b["owner"] == player else -1.0)
                obs.append(self._bullet_heading_toward(
                    ego["x"], ego["y"],
                    b["x"], b["y"], b["vx"], b["vy"],
                ))
            else:
                obs.extend([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])

        # --- Local wall grid (5x5 x 2 = 50 values) [53..102] ---
        ego_col = int(ego["x"] // CELL_SIZE)
        ego_row = int(ego["y"] // CELL_SIZE)
        for dr in range(-WALL_GRID_RADIUS, WALL_GRID_RADIUS + 1):
            for dc in range(-WALL_GRID_RADIUS, WALL_GRID_RADIUS + 1):
                r = ego_row + dr
                c = ego_col + dc
                if 0 <= r < MAZE_ROWS and 0 <= c < MAZE_COLS:
                    obs.append(1.0 if self._has_wall(r, c, "top") else 0.0)
                    obs.append(1.0 if self._has_wall(r, c, "right") else 0.0)
                else:
                    obs.extend([1.0, 1.0])

        # --- Metadata (3 values) [103..105] ---
        obs.append(self._tick / self._phase_config.max_episode_ticks)
        ego_bullets = sum(1 for b in self._bullets if b["owner"] == player)
        obs.append(ego_bullets / MAX_BULLETS)
        opp_bullets = sum(1 for b in self._bullets if b["owner"] == (1 - player))
        obs.append(opp_bullets / MAX_BULLETS)

        # --- Line of sight to opponent (2 values) [106..107] ---
        if opp["alive"]:
            has_los = not self._line_segment_crosses_any_wall(
                ego["x"], ego["y"], opp["x"], opp["y"]
            )
            dist = math.hypot(opp["x"] - ego["x"], opp["y"] - ego["y"])
            obs.append(1.0 if has_los else 0.0)
            obs.append(dist / max_dist if has_los else 0.0)
        else:
            obs.extend([0.0, 0.0])

        # --- Wall raycasts in 12 directions (12 values) [108..119] ---
        # Every 30° relative to ego facing
        for offset_deg in range(0, 360, 30):
            ray_angle = ego["angle"] + offset_deg
            wall_dist = self._raycast_wall_distance(
                ego["x"], ego["y"], ray_angle, max_dist
            )
            obs.append(wall_dist / max_dist)

        # --- BFS compass to opponent (3 values) [120..122] ---
        if player == 0 and self._cached_bfs is not None:
            cos_dir, sin_dir, path_dist = self._cached_bfs
            # Rotate world direction into ego-relative frame
            rel_cos = cos_dir * cos_ego + sin_dir * sin_ego
            rel_sin = -cos_dir * sin_ego + sin_dir * cos_ego
            obs.append(rel_cos)
            obs.append(rel_sin)
            obs.append(path_dist)
        else:
            rel_cos = 0.0
            rel_sin = 0.0
            obs.extend([0.0, 0.0, 0.0])

        # --- BFS quadrant hint one-hot (4 values) [123..126] ---
        # [1,0,0,0]=forward, [0,1,0,0]=left, [0,0,1,0]=right, [0,0,0,1]=backward
        # Tells the agent WHERE the opponent is, not what action to take.
        bfs_angle = math.atan2(rel_sin, rel_cos)
        if abs(rel_cos) < 0.01 and abs(rel_sin) < 0.01:
            obs.extend([0.0, 0.0, 0.0, 0.0])  # no BFS signal
        elif abs(bfs_angle) < math.radians(45):
            obs.extend([1.0, 0.0, 0.0, 0.0])  # forward
        elif bfs_angle < -math.radians(135) or bfs_angle > math.radians(135):
            obs.extend([0.0, 0.0, 0.0, 1.0])  # backward
        elif rel_sin < 0:
            obs.extend([0.0, 1.0, 0.0, 0.0])  # left
        else:
            obs.extend([0.0, 0.0, 1.0, 0.0])  # right

        # --- Aim alignment (2 values) [127..128] ---
        # cos and sin of (barrel_angle - bearing_to_opponent)
        # NOT gated by LOS — agent can pre-aim while navigating behind walls.
        # LOS boolean at [106] already tells the agent whether to fire.
        barrel_angle = math.radians(ego["angle"])
        if opp["alive"]:
            dx = opp["x"] - ego["x"]
            dy = opp["y"] - ego["y"]
            dist_to_opp = math.hypot(dx, dy)
            bearing = math.atan2(dy, dx)
            aim_diff = barrel_angle - bearing
            obs.append(math.cos(aim_diff))  # [123]
            obs.append(math.sin(aim_diff))  # [124] signed turn direction
        else:
            dist_to_opp = 0.0
            bearing = 0.0
            obs.extend([0.0, 0.0])

        # --- Lead angle (3 values) [125..127] ---
        # Predictive aim: bearing to where opponent will be when bullet arrives
        # lead_cos, lead_sin (relative to ego facing), signed error to lead point
        if opp["alive"] and dist_to_opp > 1.0:
            opp_vx = opp["speed"] * math.cos(math.radians(opp["angle"]))
            opp_vy = opp["speed"] * math.sin(math.radians(opp["angle"]))
            t = dist_to_opp / BULLET_SPEED
            for _ in range(2):  # 2 iterations converge
                pred_x = opp["x"] + opp_vx * t
                pred_y = opp["y"] + opp_vy * t
                t = math.hypot(pred_x - ego["x"], pred_y - ego["y"]) / BULLET_SPEED
            lead_bearing = math.atan2(pred_y - ego["y"], pred_x - ego["x"])
            lead_rel = lead_bearing - barrel_angle
            obs.append(math.cos(lead_rel))   # [125] lead cos (ego-relative)
            obs.append(math.sin(lead_rel))   # [126] lead sin (ego-relative)
            obs.append(math.sin(barrel_angle - lead_bearing))  # [127] signed error to lead
        else:
            obs.extend([0.0, 0.0, 0.0])

        # --- Shot difficulty (2 values) [128..129] ---
        # Angular width of target, time-to-impact
        if opp["alive"] and dist_to_opp > 1.0:
            obs.append(math.atan2(TANK_WIDTH, dist_to_opp) / math.pi)  # [128] angular width
            obs.append(min(dist_to_opp / BULLET_SPEED / BULLET_LIFETIME, 1.0))  # [129] TTI
        else:
            obs.extend([0.0, 0.0])

        # --- Threat awareness: enemy bullets (4 values) [130..133] ---
        # Count, nearest dist, nearest angle cos/sin
        threat_count = 0
        threat_radius = THREAT_RADIUS_ENEMY
        nearest_threat_dist = 1.0
        nearest_threat_angle_cos = 0.0
        nearest_threat_angle_sin = 0.0
        for b in self._bullets:
            if b["owner"] == player:
                continue
            b_dist = math.hypot(b["x"] - ego["x"], b["y"] - ego["y"])
            heading = self._bullet_heading_toward(
                ego["x"], ego["y"], b["x"], b["y"], b["vx"], b["vy"]
            )
            if b_dist <= threat_radius and heading > THREAT_HEADING_THRESHOLD:
                threat_count += 1
                norm_dist = b_dist / threat_radius
                if norm_dist < nearest_threat_dist:
                    nearest_threat_dist = norm_dist
                    t_dx = b["x"] - ego["x"]
                    t_dy = b["y"] - ego["y"]
                    t_ego_x = t_dx * cos_ego + t_dy * sin_ego
                    t_ego_y = -t_dx * sin_ego + t_dy * cos_ego
                    t_angle = math.atan2(t_ego_y, t_ego_x)
                    nearest_threat_angle_cos = math.cos(t_angle)
                    nearest_threat_angle_sin = math.sin(t_angle)
        obs.append(min(threat_count / MAX_BULLETS, 1.0))  # [130]
        obs.append(nearest_threat_dist if threat_count > 0 else 0.0)  # [131]
        obs.append(nearest_threat_angle_cos)  # [132]
        obs.append(nearest_threat_angle_sin)  # [133]

        # --- Self-bullet threat (4 values) [134..137] ---
        # Own bullets near self (self-kill risk): count, nearest dist, angle cos/sin
        self_threat_count = 0
        self_threat_radius = THREAT_RADIUS_SELF
        nearest_self_dist = 1.0
        nearest_self_angle_cos = 0.0
        nearest_self_angle_sin = 0.0
        for b in self._bullets:
            if b["owner"] != player:
                continue
            b_dist = math.hypot(b["x"] - ego["x"], b["y"] - ego["y"])
            heading = self._bullet_heading_toward(
                ego["x"], ego["y"], b["x"], b["y"], b["vx"], b["vy"]
            )
            if b_dist <= self_threat_radius and heading > THREAT_HEADING_THRESHOLD:
                self_threat_count += 1
                norm_dist = b_dist / self_threat_radius
                if norm_dist < nearest_self_dist:
                    nearest_self_dist = norm_dist
                    s_dx = b["x"] - ego["x"]
                    s_dy = b["y"] - ego["y"]
                    s_ego_x = s_dx * cos_ego + s_dy * sin_ego
                    s_ego_y = -s_dx * sin_ego + s_dy * cos_ego
                    s_angle = math.atan2(s_ego_y, s_ego_x)
                    nearest_self_angle_cos = math.cos(s_angle)
                    nearest_self_angle_sin = math.sin(s_angle)
        obs.append(min(self_threat_count / MAX_BULLETS, 1.0))  # [134]
        obs.append(nearest_self_dist if self_threat_count > 0 else 0.0)  # [135]
        obs.append(nearest_self_angle_cos)  # [136]
        obs.append(nearest_self_angle_sin)  # [137]

        # --- Tactical (2 values) [138..139] ---
        # Time since last fired (normalized), opponent facing me
        ticks_since_fire = self._tick - self._last_fire_tick[player]
        obs.append(min(ticks_since_fire / FIRE_COOLDOWN_TICKS, 1.0) if FIRE_COOLDOWN_TICKS > 0 else 1.0)  # [138]
        if opp["alive"]:
            opp_rad = math.radians(opp["angle"])
            opp_to_ego_angle = math.atan2(ego["y"] - opp["y"], ego["x"] - opp["x"])
            obs.append(math.cos(opp_rad - opp_to_ego_angle))  # [139]
        else:
            obs.append(0.0)

        # --- Barrel wall distance (1 value) [140] ---
        # Raycast along barrel direction — tells agent how far bullet will travel before wall
        barrel_wall = self._raycast_wall_distance(
            ego["x"], ego["y"], ego["angle"], max_dist
        )
        obs.append(barrel_wall / max_dist)  # [140]

        # --- Firing solution (3 values) [141..143] ---
        shot_hit, shot_dist, shot_self, _ = self._trace_firing_solution(player)
        obs.append(shot_hit)   # [141] 1.0 if firing now would hit opponent
        obs.append(shot_dist)  # [142] normalized distance to hit point
        obs.append(shot_self)  # [143] 1.0 if firing now would hit self (ricochet)

        # --- Ammo fraction (1 value) [144] ---
        max_ammo = max(self._phase_config.max_ammo_per_life, 1)
        obs.append(self._ammo[player] / max_ammo)  # [144]

        result = np.array(obs, dtype=np.float32)
        np.clip(result, -1.0, 1.0, out=result)
        assert result.shape == (OBS_DIM,), (
            f"Observation shape mismatch: expected ({OBS_DIM},), got {result.shape}. "
            f"len(obs)={len(obs)}"
        )
        return result

    # ------------------------------------------------------------------
    # Reward shaping
    # ------------------------------------------------------------------

    def _compute_shaping_reward(self) -> float:
        """Called every physics tick (60Hz). Returns small shaping reward.

        All reward values read from self._phase_config — no scattered constants.
        """
        cfg = self._phase_config
        ego = self._tanks[0]
        opp = self._tanks[1]

        if not ego["alive"]:
            return 0.0

        reward = 0.0

        # Wall hit penalty — scaled by how head-on the agent hits.
        # Perpendicular (ramming) = full penalty, parallel (sliding) = no penalty.
        if self._tank_wall_normal is not None:
            nx, ny = self._tank_wall_normal
            facing_rad = math.radians(ego["angle"])
            # |cos(angle between facing and wall normal)| = how head-on
            head_on = abs(math.cos(facing_rad) * nx + math.sin(facing_rad) * ny)
            reward += cfg.reward_wall_hit * head_on

        # Survival bonus — tiny per-tick reward for staying alive
        reward += cfg.reward_survival

        # Idle penalty — penalize standing still
        if abs(ego["speed"]) < 1.0:
            reward += cfg.reward_idle

        # BFS follow reward — reward moving forward toward the BFS waypoint.
        # Uses dot product of facing direction vs BFS direction. Only fires when
        # the agent is actually moving forward (not reversing or stationary).
        if cfg.reward_bfs_follow > 0.0 and self._cached_bfs is not None:
            cap = cfg.reward_bfs_follow_cap
            if cap == 0 or self._bfs_follow_count < cap:
                cos_dir, sin_dir, _ = self._cached_bfs
                prev = self._prev_tanks[0]
                move_dist = math.hypot(ego["x"] - prev["x"], ego["y"] - prev["y"])
                if move_dist > 0.5:  # agent is actually moving
                    facing_rad = math.radians(ego["angle"])
                    facing_cos = math.cos(facing_rad)
                    facing_sin = math.sin(facing_rad)
                    # Is agent moving forward (not backward)?
                    move_nx = (ego["x"] - prev["x"]) / move_dist
                    move_ny = (ego["y"] - prev["y"]) / move_dist
                    if move_nx * facing_cos + move_ny * facing_sin > 0.0:
                        # How well is facing direction aligned with BFS?
                        bfs_dot = facing_cos * cos_dir + facing_sin * sin_dir
                        if bfs_dot > 0.0:
                            reward += cfg.reward_bfs_follow * bfs_dot
                            self._bfs_follow_count += 1

        return reward

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def render(self) -> np.ndarray | None:
        """Render the current game state using pygame."""
        if self.render_mode is None:
            return None

        import pygame

        if not hasattr(self, "_screen"):
            if self.render_mode == "human":
                pygame.init()
                self._screen = pygame.display.set_mode((ARENA_W, ARENA_H))
                pygame.display.set_caption("TankBattle Training")
            else:
                # For rgb_array: use offscreen Surface. Set SDL to dummy
                # video driver to avoid macOS main-thread crash.
                os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
                pygame.init()
                self._screen = pygame.Surface((ARENA_W, ARENA_H))
            self._clock = pygame.time.Clock()

        # Background: #0a0e1a
        self._screen.fill((10, 14, 26))

        # Draw walls
        for seg in self._segments:
            x1, y1, x2, y2 = seg
            pygame.draw.line(
                self._screen,
                (100, 116, 139),
                (int(x1), int(y1)),
                (int(x2), int(y2)),
                2,
            )

        # Draw tanks
        colors = {0: (74, 222, 128), 1: (248, 113, 113)}
        for pid in [0, 1]:
            tank = self._tanks[pid]
            if not tank["alive"]:
                continue
            cx = int(tank["x"])
            cy = int(tank["y"])
            pygame.draw.circle(
                self._screen, colors[pid], (cx, cy), TANK_WIDTH // 2
            )
            rad = math.radians(tank["angle"])
            bx = cx + int(math.cos(rad) * BARREL_LENGTH)
            by = cy + int(math.sin(rad) * BARREL_LENGTH)
            pygame.draw.line(
                self._screen, (255, 255, 255), (cx, cy), (bx, by), 3
            )

        # Draw bullets
        for b in self._bullets:
            color = colors.get(b["owner"], (255, 255, 255))
            pygame.draw.circle(
                self._screen, color, (int(b["x"]), int(b["y"])), 3
            )

        if self.render_mode == "human":
            pygame.display.flip()
            self._clock.tick(self.metadata["render_fps"])
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    pygame.quit()
            return None
        else:  # rgb_array
            return np.transpose(
                np.array(pygame.surfarray.pixels3d(self._screen)),
                axes=(1, 0, 2),
            ).copy()

    # ------------------------------------------------------------------
    # Close
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Clean up pygame resources."""
        if hasattr(self, "_screen"):
            import pygame
            pygame.quit()
            del self._screen


# ---------------------------------------------------------------------------
# Gymnasium registration
# ---------------------------------------------------------------------------
gymnasium.register(id="TankBattle-v0", entry_point="tank_env:TankBattleEnv")
