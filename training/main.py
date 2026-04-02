"""Training dispatcher — supports PPO and DDQN algorithms for CartPole, LunarLander, and TankBattle.

Usage:
    uv run python main.py --algo ppo --env cartpole          # PPO on CartPole
    uv run python main.py --algo ppo --env tank --phase 0     # PPO on Tank Phase 0
    uv run python main.py --algo ddqn --env cartpole          # DDQN on CartPole
    uv run python main.py --env tank --phase 3                # PPO on full game (default)
    uv run python main.py --eval --render                     # Watch trained agent
    uv run python main.py --resume                            # Resume from checkpoint
"""

import argparse
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import torch

# ─── Version-aware directory structure ───
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
    device = "cuda"
elif torch.backends.mps.is_available():
    device = "mps"
else:
    device = "cpu"


@dataclass
class EnvConfig:
    """Per-environment hyperparameter overrides."""

    env_name: str
    gym_id: str
    hidden_dim: int
    total_timesteps: int
    learning_rate: float
    num_envs: int
    video_interval: int
    checkpoint_interval: int

    # DDQN-specific (ignored by PPO)
    replay_memory_size: int = 0
    learning_starts: int = 0
    network_sync_rate: int = 0
    exploration_fraction: float = 0.0
    enable_dueling_dqn: bool = False
    use_per: bool = False
    per_alpha: float = 0.6
    per_beta_start: float = 0.4


# ─── Environment configs ───

CARTPOLE_CONFIG = EnvConfig(
    env_name="cartpole",
    gym_id="CartPole-v1",
    hidden_dim=128,
    total_timesteps=700_000,
    learning_rate=2.5e-4,
    num_envs=1,
    video_interval=50,
    checkpoint_interval=50_000,
    # DDQN
    replay_memory_size=50_000,
    learning_starts=5_000,
    network_sync_rate=500,
    exploration_fraction=0.5,
    enable_dueling_dqn=False,
    use_per=True,
)

LUNAR_CONFIG = EnvConfig(
    env_name="lunar",
    gym_id="LunarLander-v3",
    hidden_dim=64,
    total_timesteps=500_000,
    learning_rate=2.5e-4,
    num_envs=4,
    video_interval=50,
    checkpoint_interval=50_000,
    # DDQN
    replay_memory_size=10_000,
    learning_starts=1_000,
    network_sync_rate=1_000,
    exploration_fraction=0.3,
    enable_dueling_dqn=True,
)

TANK_CONFIG = EnvConfig(
    env_name="tank",
    gym_id="TankBattle-v0",
    hidden_dim=256,
    total_timesteps=100_000_000,
    learning_rate=2.5e-4,
    num_envs=8,
    video_interval=5000,
    checkpoint_interval=100_000,
    # DDQN
    replay_memory_size=200_000,
    learning_starts=10_000,
    network_sync_rate=1_000,
    exploration_fraction=0.25,
    enable_dueling_dqn=True,
    use_per=True,
)

ENV_CONFIGS: dict[str, EnvConfig] = {
    "cartpole": CARTPOLE_CONFIG,
    "lunar": LUNAR_CONFIG,
    "tank": TANK_CONFIG,
}


def _make_dirs(env_name: str) -> tuple[str, str, str]:
    """Create and return (runs_dir, checkpoint_dir, video_dir)."""
    if env_name == "tank":
        runs_dir = os.path.join("runs", f"v{ENV_VERSION}")
    else:
        runs_dir = os.path.join("runs", env_name)
    checkpoint_dir = os.path.join(runs_dir, "checkpoints")
    video_dir = os.path.join(runs_dir, "videos")
    os.makedirs(runs_dir, exist_ok=True)
    os.makedirs(checkpoint_dir, exist_ok=True)
    os.makedirs(video_dir, exist_ok=True)

    if env_name == "tank":
        snapshot_path = os.path.join(runs_dir, "constants_snapshot.json")
        if not os.path.exists(snapshot_path):
            shutil.copy(_CONSTANTS_PATH, snapshot_path)

    return runs_dir, checkpoint_dir, video_dir


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Training dispatcher for CartPole, LunarLander, and TankBattle"
    )
    parser.add_argument(
        "--algo", type=str, default="ppo", choices=["ppo", "ddqn"],
        help="Algorithm to use (default: ppo)",
    )
    parser.add_argument(
        "--env", type=str, default="cartpole", choices=["cartpole", "lunar", "tank"],
        help="Environment to train on (default: cartpole)",
    )
    parser.add_argument("--eval", action="store_true", help="Run evaluation (no training)")
    parser.add_argument("--render", action="store_true", help="Open live game window")
    parser.add_argument("--resume", action="store_true", help="Resume from last checkpoint")
    parser.add_argument(
        "--phase", type=int, default=0, choices=[0, 1, 2, 3],
        help="Curriculum phase: 0=nav+shoot, 1=combat, 2=full game (default: 0)",
    )
    parser.add_argument(
        "--auto-promote", action="store_true",
        help="Auto-promote to next phase when win rate threshold is reached",
    )
    parser.add_argument(
        "--self-play", action="store_true",
        help="Use current best model as opponent",
    )
    parser.add_argument(
        "--run", type=str, default=None,
        help="Run directory name (e.g. 'v2'). Overrides default version-based naming.",
    )
    parser.add_argument(
        "--tensorboard", action="store_true",
        help="Launch TensorBoard alongside training",
    )
    args = parser.parse_args()

    config = ENV_CONFIGS[args.env]

    # Shared directory setup
    if args.run:
        # Override run directory
        runs_dir = os.path.join("runs", args.run)
        checkpoint_dir = os.path.join(runs_dir, "checkpoints")
        video_dir = os.path.join(runs_dir, "videos")
        os.makedirs(runs_dir, exist_ok=True)
        os.makedirs(checkpoint_dir, exist_ok=True)
        os.makedirs(video_dir, exist_ok=True)
    else:
        runs_dir, checkpoint_dir, video_dir = _make_dirs(config.env_name)

    if config.env_name == "tank":
        model_suffix = f"tankbet-v{ENV_VERSION}"
    else:
        model_suffix = config.env_name

    model_file = os.path.join(runs_dir, f"{args.algo}_{model_suffix}_latest.pt")
    best_model_file = os.path.join(runs_dir, f"{args.algo}_{model_suffix}_best.pt")
    state_file = os.path.join(runs_dir, f"{args.algo}_training_state.pt")

    # Print config
    phase_names = {0: "nav + shoot", 1: "combat (no opp self-kill)", 2: "full rules", 3: "self-play"}
    print(f"Algorithm: {args.algo.upper()}")
    print(f"Environment: {config.gym_id}")
    print(f"Hidden dim: {config.hidden_dim}")
    print(f"Total timesteps: {config.total_timesteps:,}")
    print(f"Learning rate: {config.learning_rate}")
    print(f"Num envs: {config.num_envs}")
    if args.env == "tank":
        print(f"Training phase: {args.phase} ({phase_names.get(args.phase, 'unknown')})")
    if args.auto_promote:
        print("Auto-promote: enabled")
    if args.self_play:
        print("Self-play: enabled")
    if args.algo == "ddqn":
        print(f"Replay buffer: {config.replay_memory_size:,}")
        print(f"Learning starts: {config.learning_starts:,}")
        print(f"Target sync every: {config.network_sync_rate} steps")
        print(f"Exploration fraction: {config.exploration_fraction}")
        print(f"Dueling DQN: {config.enable_dueling_dqn}")
        print(f"PER: {config.use_per}")
    print(f"Device: {device}")
    print()

    # Launch TensorBoard
    if args.tensorboard:
        tb_proc = subprocess.Popen(
            ["uv", "run", "tensorboard", "--logdir", runs_dir, "--port", "6006"],
        )
        import webbrowser
        webbrowser.open("http://localhost:6006")
        print(f"TensorBoard started at http://localhost:6006 (pid: {tb_proc.pid})")
        print()

    # Dispatch to trainer
    if args.algo == "ppo":
        from ppo_trainer import PPOConfig, PPOTrainer

        trainer = PPOTrainer(
            env_name=config.env_name,
            gym_id=config.gym_id,
            hidden_dim=config.hidden_dim,
            total_timesteps=config.total_timesteps,
            learning_rate=config.learning_rate,
            num_envs=config.num_envs,
            runs_dir=runs_dir,
            checkpoint_dir=checkpoint_dir,
            video_dir=video_dir,
            model_file=model_file,
            best_model_file=best_model_file,
            state_file=state_file,
            video_interval=config.video_interval,
            checkpoint_interval=config.checkpoint_interval,
            device=device,
            ppo_config=PPOConfig(
                rollout_steps=4096 if config.env_name == "tank" else 128,
                separate_networks=True,  # separate actor/critic with Tanh
            ),
            training_phase=args.phase,
        )
        trainer.self_play = args.self_play
    else:
        from ddqn_trainer import DDQNTrainer

        trainer = DDQNTrainer(
            env_name=config.env_name,
            gym_id=config.gym_id,
            hidden_dim=config.hidden_dim,
            total_timesteps=config.total_timesteps,
            learning_rate=config.learning_rate,
            num_envs=config.num_envs,
            replay_memory_size=config.replay_memory_size,
            learning_starts=config.learning_starts,
            network_sync_rate=config.network_sync_rate,
            exploration_fraction=config.exploration_fraction,
            enable_dueling_dqn=config.enable_dueling_dqn,
            use_per=config.use_per,
            per_alpha=config.per_alpha,
            per_beta_start=config.per_beta_start,
            runs_dir=runs_dir,
            checkpoint_dir=checkpoint_dir,
            video_dir=video_dir,
            model_file=model_file,
            best_model_file=best_model_file,
            state_file=state_file,
            video_interval=config.video_interval,
            checkpoint_interval=config.checkpoint_interval,
            device=device,
            self_play=args.self_play,
            training_phase=args.phase,
        )

    trainer.run(
        is_training=not args.eval,
        render=args.render,
        resume=args.resume,
        auto_promote=args.auto_promote,
    )


if __name__ == "__main__":
    main()
