"""Optuna reward weight sweep for TankBattle PPO training.

Runs short training trials (~500K steps) to find optimal reward weights.
Uses TPE sampler (Bayesian) + MedianPruner (kills bad trials early).

Supports parallel trial execution via --n-jobs (each trial runs in a thread).

Usage:
    uv run python sweep.py                          # 50 trials, Phase 2
    uv run python sweep.py --n-trials 100            # more trials
    uv run python sweep.py --phase 3                 # sweep on Phase 3
    uv run python sweep.py --timesteps 1000000       # longer trials
    uv run python sweep.py --study-name my_sweep     # named study (resumable)
    uv run python sweep.py --n-jobs 4                # run 4 trials in parallel
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import random
from collections import deque
from pathlib import Path

print = functools.partial(print, flush=True)  # noqa: A001

import gymnasium as gym
import numpy as np
import optuna
import torch

from phase_config import PHASE_CONFIGS, PhaseConfig
from ppo import ActorCritic
from ppo_trainer import PPOConfig, TrainingState, anneal_learning_rate, collect_rollout, ppo_update
from rollout_buffer import RolloutBuffer

# ---------------------------------------------------------------------------
# Load constants
# ---------------------------------------------------------------------------
_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "game-engine"
    / "src"
    / "constants.json"
)
with open(_CONSTANTS_PATH) as _f:
    _constants = json.load(_f)
ENV_VERSION = _constants["ENV_VERSION"]

if torch.cuda.is_available():
    DEVICE = "cuda"
elif torch.backends.mps.is_available():
    DEVICE = "mps"
else:
    DEVICE = "cpu"


# ---------------------------------------------------------------------------
# Build a PhaseConfig with trial-suggested reward weights
# ---------------------------------------------------------------------------
def make_phase_config_from_trial(trial: optuna.Trial, base_phase: int) -> PhaseConfig:
    """Create a PhaseConfig using Optuna-suggested reward weights."""
    base = PHASE_CONFIGS[base_phase]

    # Sweep over the 3 active shaping signals
    reward_bfs_follow = trial.suggest_float("bfs_follow", 0.01, 0.2, log=True)
    reward_good_aim = trial.suggest_float("good_aim", 0.05, 0.5)
    reward_wall_hit = -trial.suggest_float("wall_hit_abs", 0.005, 0.1, log=True)

    # Construct config with swept values, keeping env rules from base phase
    return PhaseConfig(
        # Environment rules — fixed from base phase
        lives=base.lives,
        max_episode_ticks=base.max_episode_ticks,
        opponent_can_fire=base.opponent_can_fire,
        opp_fire_cooldown_ticks=base.opp_fire_cooldown_ticks,
        use_maze=base.use_maze,
        spawn_distance_fraction=base.spawn_distance_fraction,
        opponent_stationary=base.opponent_stationary,
        self_damage_prob=base.self_damage_prob,
        # Swept reward values
        reward_bfs_follow=reward_bfs_follow,
        reward_good_aim=reward_good_aim,
        reward_wall_hit=reward_wall_hit,
        # Promotion thresholds — not used in sweep
        promote_win_rate=1.0,
        promote_min_episodes=999_999_999,
    )


# ---------------------------------------------------------------------------
# Single trial: train for N steps and return win rate
# ---------------------------------------------------------------------------
def run_trial(
    trial: optuna.Trial,
    phase: int,
    total_timesteps: int,
    num_envs: int,
    report_interval: int,
) -> float:
    """Run a single training trial and return final win rate."""
    seed = 42 + trial.number  # Vary seed per trial for diversity
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)

    phase_config = make_phase_config_from_trial(trial, phase)
    ppo = PPOConfig(rollout_steps=2048, separate_networks=True, clip_epsilon=0.2)
    learning_rate = 2.5e-4

    # Create envs with custom phase config
    def make_env() -> gym.Env:
        from tank_env import TankBattleEnv
        env = TankBattleEnv(
            render_mode=None,
            training_phase=phase,
        )
        # Override phase config with swept values
        env._phase_config = phase_config
        env = gym.wrappers.NormalizeReward(env, gamma=ppo.gamma)
        return env

    envs = gym.vector.AsyncVectorEnv([make_env for _ in range(num_envs)])

    # Get dims
    tmp_env = make_env()
    num_states: int = tmp_env.observation_space.shape[0]  # type: ignore[index]
    num_actions: int = tmp_env.action_space.n  # type: ignore[attr-defined]
    tmp_env.close()

    model = ActorCritic(num_states, num_actions, 256, separate=True).to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate, eps=1e-5)

    states, _ = envs.reset(seed=seed)
    states_t = torch.tensor(states, dtype=torch.float, device=DEVICE)
    dones_t = torch.zeros(num_envs, device=DEVICE)

    ep_rewards = np.zeros(num_envs)
    ep_lengths = np.zeros(num_envs, dtype=int)

    buffer = RolloutBuffer(
        num_steps=ppo.rollout_steps,
        num_envs=num_envs,
        state_dim=num_states,
        device=DEVICE,
        gamma=ppo.gamma,
        gae_lambda=ppo.gae_lambda,
    )

    state = TrainingState()

    def on_ep_done(env_idx: int, reward: float, length: int, infos: dict) -> bool:
        if "win" in infos and infos["_win"][env_idx]:
            state.win_history.append(bool(infos["win"][env_idx]))
        return False

    while state.global_step < total_timesteps:
        anneal_learning_rate(optimizer, state.global_step, total_timesteps, learning_rate)

        states_t, dones_t, _ = collect_rollout(
            model, envs, buffer, state, DEVICE,
            states_t, dones_t, ep_rewards, ep_lengths,
            num_envs, ppo.rollout_steps,
            on_episode_done=on_ep_done,
        )

        # Compute GAE
        with torch.no_grad():
            _, _, last_value = model.get_action(states_t)
        buffer.compute_advantages(last_value, dones_t)

        ppo_update(model, optimizer, buffer, ppo)

        # Report to Optuna for pruning
        if state.global_step >= report_interval and len(state.win_history) >= 50:
            win_rate = sum(state.win_history) / len(state.win_history)
            trial.report(win_rate, state.global_step)
            if trial.should_prune():
                envs.close()
                raise optuna.TrialPruned()

    envs.close()

    # Final win rate
    if len(state.win_history) >= 50:
        return sum(state.win_history) / len(state.win_history)
    return 0.0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Optuna reward weight sweep")
    parser.add_argument("--n-trials", type=int, default=50, help="Number of trials")
    parser.add_argument("--phase", type=int, default=2, help="Phase to sweep on")
    parser.add_argument("--timesteps", type=int, default=500_000, help="Steps per trial")
    parser.add_argument("--num-envs", type=int, default=4, help="Parallel envs per trial")
    parser.add_argument("--study-name", type=str, default="tankbet_reward_sweep", help="Study name (for resuming)")
    parser.add_argument("--db", type=str, default=None, help="SQLite DB path for distributed sweeps")
    parser.add_argument("--n-jobs", type=int, default=1, help="Number of trials to run in parallel (default: 1)")
    args = parser.parse_args()

    report_interval = args.timesteps // 5  # report 5 times per trial

    print(f"Optuna reward sweep: {args.n_trials} trials, Phase {args.phase}, {args.timesteps:,} steps/trial")
    print(f"Device: {DEVICE}, {args.num_envs} envs/trial, {args.n_jobs} parallel jobs")
    print()

    # Use SQLite storage when running parallel jobs (required for thread safety)
    if args.db:
        storage = f"sqlite:///{args.db}"
    elif args.n_jobs > 1:
        db_path = os.path.join("runs", f"v{ENV_VERSION}", "sweep.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        storage = f"sqlite:///{db_path}"
        print(f"Using SQLite storage for parallel trials: {db_path}")
    else:
        storage = None

    study = optuna.create_study(
        study_name=args.study_name,
        direction="maximize",
        storage=storage,
        load_if_exists=True,
        pruner=optuna.pruners.MedianPruner(
            n_startup_trials=5,  # don't prune first 5 trials
            n_warmup_steps=report_interval,  # don't prune before first report
        ),
    )

    def objective(trial: optuna.Trial) -> float:
        return run_trial(trial, args.phase, args.timesteps, args.num_envs, report_interval)

    study.optimize(objective, n_trials=args.n_trials, n_jobs=args.n_jobs, show_progress_bar=True)

    # Print results
    print("\n" + "=" * 70)
    print("SWEEP RESULTS")
    print("=" * 70)
    print(f"Best trial: #{study.best_trial.number}")
    print(f"Best win rate: {study.best_value:.3f}")
    print(f"\nBest reward weights:")
    for key, value in study.best_params.items():
        print(f"  {key:<30} {value:+.6f}")

    # Save results
    results_path = os.path.join("runs", f"v{ENV_VERSION}", "sweep_results.json")
    os.makedirs(os.path.dirname(results_path), exist_ok=True)
    results = {
        "best_trial": study.best_trial.number,
        "best_win_rate": study.best_value,
        "best_params": study.best_params,
        "n_trials": len(study.trials),
        "phase": args.phase,
        "timesteps_per_trial": args.timesteps,
    }
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to {results_path}")

    # Print top 5 trials
    print(f"\nTop 5 trials:")
    trials_sorted = sorted(study.trials, key=lambda t: t.value if t.value is not None else -1, reverse=True)
    for t in trials_sorted[:5]:
        if t.value is not None:
            print(f"  Trial {t.number:>3}: win_rate={t.value:.3f}  params={t.params}")


if __name__ == "__main__":
    main()
