# Observation Space — TankBattle-v0

**Current layout: 147 dimensions** (`OBS_DIM = 147` in `tank_env.py`)

All values are clipped to `[-1, 1]`. The observation is **ego-centric**: positions and velocities are rotated into the ego tank's reference frame where "forward" = ego's barrel direction.

## Ego-centric frame convention

Given ego angle `θ`, the rotation from world to ego frame is:

```
ego_x =  (world_x - ego.x) * cos(θ) + (world_y - ego.y) * sin(θ)
ego_y = -(world_x - ego.x) * sin(θ) + (world_y - ego.y) * cos(θ)
```

Positive `ego_x` = ahead of the tank. Positive `ego_y` = to the right.

---

## Dimension layout

### [0..6] Ego tank (7 values)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 0 | `ego_x` | `ego.x / ARENA_W` | [0, 1] |
| 1 | `ego_y` | `ego.y / ARENA_H` | [0, 1] |
| 2 | `ego_angle_cos` | `cos(ego.angle)` | [-1, 1] |
| 3 | `ego_angle_sin` | `sin(ego.angle)` | [-1, 1] |
| 4 | `ego_speed` | `ego.speed / TANK_SPEED` | [-1, 1] |
| 5 | `ego_alive` | `1.0` if alive, `0.0` if dead | {0, 1} |
| 6 | `ego_can_fire` | `1.0` if cooldown elapsed and ammo > 0 | {0, 1} |

**Notes**: `ego_alive` is always 1.0 during observation (episode ends on death), making it a wasted dim. `ego_x` and `ego_y` are absolute positions — useful for understanding arena-level positioning but not ego-centric.

### [7..14] Opponent (ego-centric) (8 values)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 7 | `opp_rel_x` | Ego-frame relative x, normalized by `hypot(ARENA_W, ARENA_H)` | [-1, 1] |
| 8 | `opp_rel_y` | Ego-frame relative y, normalized by `hypot(ARENA_W, ARENA_H)` | [-1, 1] |
| 9 | `opp_heading_cos` | `cos(opp.angle - ego.angle)` — relative heading | [-1, 1] |
| 10 | `opp_heading_sin` | `sin(opp.angle - ego.angle)` — relative heading | [-1, 1] |
| 11 | `opp_speed` | `opp.speed / TANK_SPEED` | [-1, 1] |
| 12 | `opp_alive` | `1.0` if alive, `0.0` if dead | {0, 1} |
| 13 | `opp_bearing_cos` | `cos(atan2(rel_y, rel_x))` — bearing to opponent in ego frame | [-1, 1] |
| 14 | `opp_bearing_sin` | `sin(atan2(rel_y, rel_x))` — bearing to opponent in ego frame | [-1, 1] |

**Notes**: `opp_bearing` (dims 13-14) is derivable from `opp_rel_x`/`opp_rel_y` — it's `atan2(rel_y, rel_x)` which a small network may struggle to compute internally. However it is partially redundant.

### [15..50] Bullets (6 slots × 6 values = 36)

Bullets sorted by distance to ego. Each slot:

| Offset | Name | Computation | Range |
|--------|------|-------------|-------|
| +0 | `b_rel_x` | Ego-frame bullet x, normalized by max_dist | [-1, 1] |
| +1 | `b_rel_y` | Ego-frame bullet y, normalized by max_dist | [-1, 1] |
| +2 | `b_vel_x` | Ego-frame bullet vx, normalized by `BULLET_SPEED` | [-1, 1] |
| +3 | `b_vel_y` | Ego-frame bullet vy, normalized by `BULLET_SPEED` | [-1, 1] |
| +4 | `b_owner` | `+1.0` if ego's bullet, `-1.0` if opponent's | {-1, 1} |
| +5 | `b_heading_toward` | Dot product of bullet velocity with direction to ego, normalized. Positive = approaching. | [-1, 1] |

Empty slots are all zeros.

**Slot mapping**: Slot 0 = dims [15..20], Slot 1 = [21..26], ..., Slot 5 = [45..50].

### [51..100] Local wall grid (5×5 × 2 = 50 values)

A 5×5 grid centered on the ego's current maze cell. For each cell, two booleans:

| Offset | Name | Description |
|--------|------|-------------|
| +0 | `has_top_wall` | 1.0 if wall on top edge, 0.0 otherwise |
| +1 | `has_right_wall` | 1.0 if wall on right edge, 0.0 otherwise |

Out-of-bounds cells default to `(1.0, 1.0)` (walls on all sides).

**Layout order**: Row-major starting from `(ego_row - 2, ego_col - 2)` to `(ego_row + 2, ego_col + 2)`.

**Note**: This grid is in **world frame** (top/right are always compass directions), not ego frame. The agent uses `ego_angle_cos`/`ego_angle_sin` (dims 2-3) to interpret the grid orientation relative to its facing.

### [101..103] Metadata (3 values)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 101 | `time_ratio` | `tick / max_episode_ticks` | [0, 1] |
| 102 | `ego_bullet_count` | `ego_bullets / MAX_BULLETS` | [0, 1] |
| 103 | `opp_bullet_count` | `opp_bullets / MAX_BULLETS` | [0, 1] |

### [104..105] Line of sight to opponent (2 values)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 104 | `has_los` | `1.0` if no wall between ego and opponent | {0, 1} |
| 105 | `los_distance` | Distance to opponent / max_dist (0 if no LOS) | [0, 1] |

Computed via `_line_segment_crosses_any_wall()` — a raycast from ego center to opponent center checking all wall segments.

### [106..117] Wall raycasts (12 values)

12 rays every 30° relative to ego's facing direction:

| Dim | Direction (ego-relative) | Computation |
|-----|--------------------------|-------------|
| 106 | 0° (ahead) | `raycast_distance / max_dist` |
| 107 | 30° (ahead-right) | |
| 108 | 60° (right-forward) | |
| 109 | 90° (right) | |
| 110 | 120° (right-back) | |
| 111 | 150° (behind-right) | |
| 112 | 180° (behind) | |
| 113 | 210° (behind-left) | |
| 114 | 240° (left-back) | |
| 115 | 270° (left) | |
| 116 | 300° (left-forward) | |
| 117 | 330° (ahead-left) | |

Each ray uses `_raycast_wall_distance()` which steps along the ray direction checking wall segment intersections. Capped at `max_dist = hypot(ARENA_W, ARENA_H)`.

### [118..120] BFS compass (3 values)

Shortest-path direction to opponent via A* on a sub-grid (4×4 cells per maze cell).

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 118 | `bfs_dir_cos` | cos of BFS direction, rotated into ego frame | [-1, 1] |
| 119 | `bfs_dir_sin` | sin of BFS direction, rotated into ego frame | [-1, 1] |
| 120 | `bfs_path_dist` | Normalized path distance (sub-grid steps / max) | [0, 1] |

The BFS direction points along the first step of the optimal path around walls to the opponent. It's the most expensive observation to compute — cached and updated every `BFS_UPDATE_INTERVAL` ticks.

### [121..124] BFS quadrant hint (4 values, one-hot)

Discretized version of BFS compass into 4 quadrants (ego-relative):

| Pattern | Meaning |
|---------|---------|
| `[1,0,0,0]` | Forward (within ±45° of ahead) |
| `[0,1,0,0]` | Left |
| `[0,0,1,0]` | Right |
| `[0,0,0,1]` | Backward |
| `[0,0,0,0]` | No BFS signal |

**Note**: This is a lossy discretization of dims [118..119]. Partially redundant — included to give the network an easy-to-decode directional signal.

### [125..126] Aim alignment (2 values)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 125 | `aim_cos` | `cos(barrel_angle - bearing_to_opp)` | [-1, 1] |
| 126 | `aim_sin` | `sin(barrel_angle - bearing_to_opp)` — signed turn direction | [-1, 1] |

**Not gated by LOS** — the agent can pre-aim while navigating behind walls. The LOS boolean at dim [104] tells the agent whether a direct shot would connect.

### [127..129] Lead angle (3 values)

Predictive aim: where the opponent will be when the bullet arrives.

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 127 | `lead_cos` | cos of lead bearing (ego-relative) | [-1, 1] |
| 128 | `lead_sin` | sin of lead bearing (ego-relative) | [-1, 1] |
| 129 | `lead_error` | `sin(barrel_angle - lead_bearing)` — signed error | [-1, 1] |

Uses iterative convergence (2 iterations):
1. Estimate time-to-impact: `t = dist / BULLET_SPEED`
2. Predict opponent position: `pred = opp + opp_vel * t`
3. Recompute `t` from predicted position
4. Lead bearing = `atan2(pred_y - ego_y, pred_x - ego_x)`

### [130..131] Shot difficulty (2 values)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 130 | `angular_width` | `atan2(TANK_WIDTH, dist_to_opp) / π` — target size in view | [0, 1] |
| 131 | `time_to_impact` | `min(dist / BULLET_SPEED / BULLET_LIFETIME, 1.0)` | [0, 1] |

### [132..135] Threat awareness (4 values)

Enemy bullets within `threat_radius = 50px` that are heading toward ego:

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 132 | `threat_count` | `count / MAX_BULLETS` | [0, 1] |
| 133 | `nearest_threat_dist` | Distance / threat_radius (0 if no threats) | [0, 1] |
| 134 | `nearest_threat_cos` | cos of direction to nearest threat (ego-frame) | [-1, 1] |
| 135 | `nearest_threat_sin` | sin of direction to nearest threat (ego-frame) | [-1, 1] |

A bullet is considered a "threat" if `heading_toward > 0.5` (dot product of bullet velocity with direction toward ego).

### [136..139] Self-bullet threat (4 values)

Own bullets within `self_threat_radius = 120px` heading back toward ego (ricochet risk):

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 136 | `self_threat_count` | `count / MAX_BULLETS` | [0, 1] |
| 137 | `nearest_self_dist` | Distance / self_threat_radius (0 if no threats) | [0, 1] |
| 138 | `nearest_self_cos` | cos of direction to nearest self-threat (ego-frame) | [-1, 1] |
| 139 | `nearest_self_sin` | sin of direction to nearest self-threat (ego-frame) | [-1, 1] |

Larger radius (120px vs 50px for enemy threats) because self-kill is more consequential and the agent has more time to react.

### [140..141] Tactical (2 values)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 140 | `time_since_fired` | `min(ticks_since_fire / FIRE_COOLDOWN_TICKS, 1.0)` | [0, 1] |
| 141 | `opp_facing_me` | `cos(opp.angle - bearing_from_opp_to_ego)` | [-1, 1] |

`opp_facing_me = 1.0` means opponent is aimed directly at ego. `-1.0` means facing away.

### [142] Barrel wall distance (1 value)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 142 | `barrel_wall_dist` | Raycast along barrel direction / max_dist | [0, 1] |

**Note**: This is identical to `raycasts[0]` (dim 106) since raycast 0 is also at 0° (barrel direction). Redundant.

### [143..145] Firing solution (3 values)

Traces a hypothetical bullet from the barrel tip through wall bounces:

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 143 | `shot_would_hit` | `1.0` if the traced bullet hits the opponent | {0, 1} |
| 144 | `shot_hit_distance` | Normalized travel distance to hit point | [0, 1] |
| 145 | `shot_would_hit_self` | `1.0` if the bullet would ricochet back to hit ego | {0, 1} |

The trace follows `_trace_firing_solution()`:
1. Start from barrel tip (ego position + barrel_length along barrel angle)
2. Step along bullet direction at `BULLET_SPEED`
3. On wall collision: reflect velocity (bounce)
4. Check if bullet hits opponent hitbox (within `TANK_WIDTH/2`)
5. Check if bullet hits ego hitbox (self-kill)
6. Cap total travel distance at `BULLET_SPEED * BULLET_LIFETIME` (~1800px)

### [146] Ammo fraction (1 value)

| Dim | Name | Computation | Range |
|-----|------|-------------|-------|
| 146 | `ammo_fraction` | `ammo_remaining / max_ammo_per_life` | [0, 1] |

---

## Constants reference

| Constant | Value | Source |
|----------|-------|--------|
| `CELL_SIZE` | 120 | constants.json |
| `MAZE_COLS` | 9 | constants.json |
| `MAZE_ROWS` | 6 | constants.json |
| `ARENA_W` | 1080 (9 × 120) | derived |
| `ARENA_H` | 720 (6 × 120) | derived |
| `TANK_SPEED` | 165 | constants.json |
| `BULLET_SPEED` | 225 | constants.json |
| `BULLET_LIFETIME` | 8s | constants.json |
| `TANK_WIDTH` | 20 | constants.json |
| `BARREL_LENGTH` | 18 | constants.json |
| `MAX_BULLETS` | 10 | tank_env.py |
| `BULLET_OBS_SLOTS` | 6 | tank_env.py |
| `WALL_GRID_RADIUS` | 2 | tank_env.py |
| `BFS_SUB_GRID` | 4 | tank_env.py |

## Debug visualization

Run `debug_obs_visual.py` to generate per-dimension verification images:

```bash
cd training
uv run python debug_obs_visual.py
```

Output: `training/debug_obs_visual/` — one PNG per logical observation group showing the game state, computed values, expected values, and PASS/FAIL verification.

## Known issues / redundancies

1. **dim 5 (`ego_alive`)**: Always 1.0 — episode ends on death, wasted dimension.
2. **dim 142 (`barrel_wall_dist`)**: Identical to dim 106 (`raycasts[0]` at 0°).
3. **dims 13-14 (`opp_bearing`)**: Derivable from dims 7-8 (`opp_rel_x/y`) via `atan2`.
4. **dims 121-124 (`bfs_quadrant`)**: Lossy discretization of dims 118-119 (`bfs_compass`).
5. **dims 0-1 (`ego_x/y`)**: Absolute position — not ego-centric, usefulness debatable.
6. **dim 140 (`time_since_fired`)**: Closely correlated with dim 6 (`can_fire`).
