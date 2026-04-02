"""PPO Trainer — Proximal Policy Optimization for CartPole, LunarLander, and TankBattle.

Implements the clipped surrogate objective with GAE advantages,
entropy bonus, and linear LR annealing. Follows CleanRL conventions.
"""

from __future__ import annotations

import functools
import os

# Force unbuffered stdout so logs flush immediately to file
print = functools.partial(print, flush=True)  # noqa: A001
import random
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import gymnasium as gym
import numpy as np
import torch
from gymnasium.wrappers import RecordVideo
from torch.utils.tensorboard import SummaryWriter

from ppo import ActorCritic
from rollout_buffer import RolloutBuffer


@dataclass
class PPOConfig:
    """PPO-specific hyperparameters (separate from shared EnvConfig)."""

    rollout_steps: int = 128  # CleanRL default (2048 for Tank)
    num_epochs: int = 4
    num_minibatches: int = 4
    clip_epsilon: float = 0.2
    entropy_coef: float = 0.03
    value_coef: float = 0.5
    max_grad_norm: float = 0.5
    gamma: float = 0.995
    gae_lambda: float = 0.98
    separate_networks: bool = True  # True=CleanRL (small envs), False=shared trunk (Tank)


@dataclass
class TrainingState:
    """Bundles all mutable training loop state into one object."""

    global_step: int = 0
    episode: int = 0
    best_reward: float = -float("inf")
    rewards_history: list[float] = field(default_factory=list)
    num_updates: int = 0
    current_phase: int = 0
    phase_episode_count: int = 0
    win_history: deque[bool] = field(default_factory=lambda: deque(maxlen=200))


@dataclass
class UpdateMetrics:
    """Aggregated metrics from a single PPO update."""

    policy_loss: float
    value_loss: float
    entropy: float
    clip_fraction: float


# ------------------------------------------------------------------
# Free functions — reusable by sweep.py and other callers
# ------------------------------------------------------------------

def anneal_learning_rate(
    optimizer: torch.optim.Optimizer,
    global_step: int,
    total_timesteps: int,
    base_lr: float,
) -> float:
    """Linear LR decay. Returns current LR."""
    frac = 1.0 - global_step / total_timesteps
    lr_now = base_lr * frac
    for pg in optimizer.param_groups:
        pg["lr"] = lr_now
    return lr_now


def collect_rollout(
    model: ActorCritic,
    envs: gym.vector.VectorEnv,
    buffer: RolloutBuffer,
    state: TrainingState,
    device: str,
    states_t: torch.Tensor,
    dones_t: torch.Tensor,
    ep_rewards: np.ndarray,
    ep_lengths: np.ndarray,
    num_envs: int,
    rollout_steps: int,
    on_episode_done: Callable[[int, float, int, dict], bool] | None = None,
) -> tuple[torch.Tensor, torch.Tensor, bool]:
    """Collect one rollout of experience. Returns (states_t, dones_t, promotion_triggered).

    The on_episode_done callback receives (env_idx, ep_reward, ep_length, infos)
    and returns True to signal early exit (e.g. promotion happened).
    """
    model.eval()
    buffer.reset()

    for step in range(rollout_steps):
        with torch.no_grad():
            action, log_prob, value = model.get_action(states_t)

        # Store BEFORE stepping (CleanRL pattern: obs/done are from current state)
        buffer.add(
            states_t,
            action,
            torch.zeros(num_envs, device=device),  # placeholder, filled below
            dones_t,  # done from PREVIOUS step (corresponds to current obs)
            value,
            log_prob,
        )

        # Step all envs
        actions_np = action.cpu().numpy()
        new_states, rewards, terminated, truncated, infos = envs.step(actions_np)

        done_flags = np.logical_or(terminated, truncated)
        buffer.rewards[step] = torch.tensor(rewards, dtype=torch.float)

        # Track episodes
        early_exit = False
        for i in range(num_envs):
            ep_rewards[i] += rewards[i]
            ep_lengths[i] += 1
            state.global_step += 1

            if done_flags[i]:
                state.episode += 1

                if on_episode_done is not None:
                    should_stop = on_episode_done(i, float(ep_rewards[i]), int(ep_lengths[i]), infos)
                    if should_stop:
                        early_exit = True

                ep_rewards[i] = 0.0
                ep_lengths[i] = 0

        if early_exit:
            return states_t, dones_t, True

        # Update state tensors
        states_t = torch.tensor(new_states, dtype=torch.float, device=device)
        dones_t = torch.tensor(done_flags, dtype=torch.float, device=device)

    return states_t, dones_t, False


def ppo_update(
    model: ActorCritic,
    optimizer: torch.optim.Optimizer,
    buffer: RolloutBuffer,
    ppo: PPOConfig,
) -> UpdateMetrics:
    """Run PPO clipped surrogate update. Returns averaged metrics."""
    model.train()

    pg_losses: list[float] = []
    v_losses: list[float] = []
    entropy_losses: list[float] = []
    clip_fracs: list[float] = []

    for _epoch in range(ppo.num_epochs):
        batches = buffer.get_batches(ppo.num_minibatches)
        for mb_obs, mb_actions, mb_old_log_probs, mb_advantages, mb_returns, mb_values in batches:
            new_log_probs, new_values, entropy = model.evaluate(mb_obs, mb_actions)

            # Ratio
            log_ratio = new_log_probs - mb_old_log_probs
            ratio = log_ratio.exp()

            # Clipped surrogate loss
            pg_loss1 = -mb_advantages * ratio
            pg_loss2 = -mb_advantages * torch.clamp(
                ratio, 1 - ppo.clip_epsilon, 1 + ppo.clip_epsilon
            )
            pg_loss = torch.max(pg_loss1, pg_loss2).mean()

            # Value loss (clipped — prevents destructive value updates)
            v_loss_unclipped = (new_values - mb_returns) ** 2
            v_clipped = mb_values + torch.clamp(
                new_values - mb_values,
                -ppo.clip_epsilon, ppo.clip_epsilon,
            )
            v_loss_clipped = (v_clipped - mb_returns) ** 2
            v_loss = 0.5 * torch.max(v_loss_unclipped, v_loss_clipped).mean()

            # Entropy bonus
            entropy_loss = entropy.mean()

            # Total loss
            loss = pg_loss + ppo.value_coef * v_loss - ppo.entropy_coef * entropy_loss

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), ppo.max_grad_norm)
            optimizer.step()

            # Track metrics
            with torch.no_grad():
                clip_frac = ((ratio - 1.0).abs() > ppo.clip_epsilon).float().mean()
                clip_fracs.append(clip_frac.item())
            pg_losses.append(pg_loss.item())
            v_losses.append(v_loss.item())
            entropy_losses.append(entropy_loss.item())

    return UpdateMetrics(
        policy_loss=float(np.mean(pg_losses)),
        value_loss=float(np.mean(v_losses)),
        entropy=float(np.mean(entropy_losses)),
        clip_fraction=float(np.mean(clip_fracs)),
    )


def log_update_metrics(
    writer: SummaryWriter,
    metrics: UpdateMetrics,
    buffer: RolloutBuffer,
    lr: float,
    num_updates: int,
    global_step: int,
) -> None:
    """Log PPO update metrics + explained variance to TensorBoard."""
    writer.add_scalar("losses/policy_loss", metrics.policy_loss, global_step)
    writer.add_scalar("losses/value_loss", metrics.value_loss, global_step)
    writer.add_scalar("losses/entropy", metrics.entropy, global_step)
    writer.add_scalar("losses/clip_fraction", metrics.clip_fraction, global_step)
    writer.add_scalar("charts/learning_rate", lr, global_step)
    writer.add_scalar("charts/update", num_updates, global_step)

    # Explained variance
    with torch.no_grad():
        b_values = buffer.values.reshape(-1)
        b_returns = buffer.returns.reshape(-1)
        var_returns = b_returns.var()
        if var_returns > 0:
            explained_var = 1 - (b_returns - b_values).var() / var_returns
        else:
            explained_var = torch.tensor(0.0)
        writer.add_scalar("charts/explained_variance", explained_var.item(), global_step)


def check_promotion(state: TrainingState, auto_promote: bool, max_phase: int = 3) -> bool:
    """Check if auto-promotion criteria are met. Returns True if promoted (increments state.current_phase)."""
    if not auto_promote or state.current_phase >= max_phase:
        return False

    from phase_config import PHASE_CONFIGS
    phase_cfg = PHASE_CONFIGS[state.current_phase]

    if (
        state.phase_episode_count >= phase_cfg.promote_min_episodes
        and len(state.win_history) >= 200
    ):
        win_rate = sum(state.win_history) / len(state.win_history)
        if win_rate >= phase_cfg.promote_win_rate:
            old_phase = state.current_phase
            state.current_phase += 1
            print(f"\n{'=' * 60}")
            print(f"AUTO-PROMOTE: Phase {old_phase} → {state.current_phase}")
            print(f"Win rate: {win_rate:.2f} >= {phase_cfg.promote_win_rate}")
            print(f"{'=' * 60}\n")

            state.phase_episode_count = 0
            state.win_history.clear()
            return True

    return False


class PPOTrainer:
    """PPO training loop with curriculum support, checkpointing, and video recording."""

    def __init__(
        self,
        env_name: str,
        gym_id: str,
        hidden_dim: int,
        total_timesteps: int,
        learning_rate: float,
        num_envs: int,
        runs_dir: str,
        checkpoint_dir: str,
        video_dir: str,
        model_file: str,
        best_model_file: str,
        state_file: str,
        video_interval: int,
        checkpoint_interval: int,
        device: str,
        ppo_config: PPOConfig | None = None,
        discount_factor: float = 0.99,
        training_phase: int = 0,
        make_single_env_fn: object = None,
    ):
        self.env_name = env_name
        self.gym_id = gym_id
        self.hidden_dim = hidden_dim
        self.total_timesteps = total_timesteps
        self.learning_rate = learning_rate
        self.num_envs = num_envs
        self.runs_dir = runs_dir
        self.checkpoint_dir = checkpoint_dir
        self.video_dir = video_dir
        self.MODEL_FILE = model_file
        self.BEST_MODEL_FILE = best_model_file
        self.STATE_FILE = state_file
        self.video_interval = video_interval
        self.checkpoint_interval = checkpoint_interval
        self.device = device
        self.discount_factor = discount_factor
        self.training_phase = training_phase
        self.self_play = False
        # Callable: (config, discount_factor, render_mode, opponent_model_path, training_phase) -> Env
        self._make_single_env_fn = make_single_env_fn

        self.ppo = ppo_config or PPOConfig()

    def run(
        self,
        is_training: bool = True,
        render: bool = False,
        resume: bool = False,
        auto_promote: bool = False,
    ) -> None:
        if not is_training:
            self._run_eval(render=render)
            return

        self._run_training(resume=resume, auto_promote=auto_promote, render=render)

    # ------------------------------------------------------------------
    # Evaluation / rendering
    # ------------------------------------------------------------------
    def _run_eval(self, render: bool = False) -> None:
        render_mode = "human" if render else None
        env = self._make_env(render_mode=render_mode, training_phase=self.training_phase, normalize_reward=False)

        num_states: int = env.observation_space.shape[0]  # type: ignore[index]
        num_actions: int = env.action_space.n  # type: ignore[attr-defined]

        model = ActorCritic(num_states, num_actions, self.hidden_dim, separate=self.ppo.separate_networks).to(self.device)

        if not os.path.exists(self.MODEL_FILE):
            print(f"No trained model found at {self.MODEL_FILE}. Train first.")
            env.close()
            return

        state_dict = torch.load(self.MODEL_FILE, map_location=self.device)
        model.load_state_dict(state_dict)
        model.eval()

        for episode in range(100):
            state, _ = env.reset()
            state_t = torch.tensor(state, dtype=torch.float, device=self.device)
            terminated = False
            truncated = False
            episode_reward = 0.0
            episode_length = 0

            while not terminated and not truncated:
                with torch.no_grad():
                    logits, _ = model(state_t.unsqueeze(0))
                    action = logits.argmax(dim=1).item()
                state, reward, terminated, truncated, _ = env.step(action)
                state_t = torch.tensor(state, dtype=torch.float, device=self.device)
                episode_reward += float(reward)
                episode_length += 1

            print(f"Episode {episode} | reward = {episode_reward:.2f} | length = {episode_length}")

        env.close()

    # ------------------------------------------------------------------
    # Training loop
    # ------------------------------------------------------------------
    def _init_training(self, phase: int) -> tuple[ActorCritic, torch.optim.Adam, SummaryWriter, int, int]:
        """Seed RNG, create model/optimizer/writer. Returns (model, optimizer, writer, num_states, num_actions)."""
        seed = 42
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)

        # Get dims from a temp env
        tmp_env = self._make_env(render_mode=None, training_phase=phase, normalize_reward=False)
        num_states: int = tmp_env.observation_space.shape[0]  # type: ignore[index]
        num_actions: int = tmp_env.action_space.n  # type: ignore[attr-defined]
        tmp_env.close()

        model = ActorCritic(num_states, num_actions, self.hidden_dim, separate=self.ppo.separate_networks).to(self.device)
        optimizer = torch.optim.Adam(model.parameters(), lr=self.learning_rate, eps=1e-5)
        writer = SummaryWriter(os.path.join(self.runs_dir, "tb_logs"))

        return model, optimizer, writer, num_states, num_actions

    def _load_checkpoint(self, model: ActorCritic, optimizer: torch.optim.Adam) -> tuple[TrainingState, dict | None]:
        """Load checkpoint if it exists. Returns (state, normalizer_state_or_None)."""
        if not os.path.exists(self.STATE_FILE):
            print(f"No checkpoint found at {self.STATE_FILE}. Starting fresh.")
            return TrainingState(current_phase=self.training_phase), None

        checkpoint = torch.load(self.STATE_FILE, map_location=self.device, weights_only=False)
        model.load_state_dict(checkpoint["model_state"])
        if checkpoint.get("optimizer_state") is not None:
            optimizer.load_state_dict(checkpoint["optimizer_state"])

        current_phase = self.training_phase
        phase_episode_count = 0
        win_history: deque[bool] = deque(maxlen=200)

        if "current_phase" in checkpoint and checkpoint["current_phase"] is not None:
            current_phase = checkpoint["current_phase"]
            self.training_phase = current_phase
            phase_episode_count = checkpoint.get("phase_episode_count", 0)
            saved_wins = checkpoint.get("win_history", [])
            win_history = deque(saved_wins, maxlen=200)

        state = TrainingState(
            global_step=checkpoint["global_step"],
            episode=checkpoint["episode"],
            best_reward=checkpoint["best_reward"],
            rewards_history=checkpoint["rewards_history"],
            num_updates=checkpoint.get("num_updates", 0),
            current_phase=current_phase,
            phase_episode_count=phase_episode_count,
            win_history=win_history,
        )
        print(f"Resumed from step {state.global_step}, episode {state.episode}, phase {state.current_phase}")
        return state, checkpoint.get("normalizer_state")

    def _create_envs(self, phase: int, render: bool) -> tuple[gym.vector.VectorEnv, int]:
        """Create vectorized envs. Returns (envs, num_envs)."""
        seed = 42
        if render:
            num_envs = 1
            envs = gym.vector.SyncVectorEnv(
                [lambda: self._make_env(render_mode="human", training_phase=phase)]
            )
            print(f"PPO training: 1 env with live render, {self.ppo.rollout_steps} steps/rollout")
        else:
            num_envs = self.num_envs
            envs = self._make_vec_envs(num_envs, phase, seed)
            print(f"PPO training: {num_envs} parallel environments, {self.ppo.rollout_steps} steps/rollout")
        return envs, num_envs

    def _run_training(self, resume: bool = False, auto_promote: bool = False, render: bool = False) -> None:
        model, optimizer, writer, num_states, num_actions = self._init_training(self.training_phase)
        state = TrainingState(current_phase=self.training_phase)

        if resume:
            state, normalizer_state = self._load_checkpoint(model, optimizer)
        else:
            normalizer_state = None

        envs, num_envs = self._create_envs(state.current_phase, render)

        if normalizer_state is not None:
            self._restore_normalizer_state(envs, normalizer_state)

        seed = 42
        states, _ = envs.reset(seed=seed)
        states_t = torch.tensor(states, dtype=torch.float, device=self.device)
        dones_t = torch.zeros(num_envs, device=self.device)

        ep_rewards = np.zeros(num_envs)
        ep_lengths = np.zeros(num_envs, dtype=int)

        buffer = RolloutBuffer(
            num_steps=self.ppo.rollout_steps,
            num_envs=num_envs,
            state_dim=num_states,
            device=self.device,
            gamma=self.ppo.gamma,
            gae_lambda=self.ppo.gae_lambda,
        )

        try:
            while state.global_step < self.total_timesteps:
                lr_now = anneal_learning_rate(optimizer, state.global_step, self.total_timesteps, self.learning_rate)

                # Episode callback — handles logging, checkpointing, video, promotion
                promoted = False

                def on_ep_done(env_idx: int, ep_reward: float, ep_length: int, infos: dict) -> bool:
                    nonlocal promoted
                    state.phase_episode_count += 1
                    state.rewards_history.append(ep_reward)
                    writer.add_scalar("charts/episode_reward", ep_reward, state.global_step)
                    writer.add_scalar("charts/episode_length", ep_length, state.global_step)
                    writer.add_scalar("charts/phase", state.current_phase, state.global_step)

                    # Track wins
                    if "win" in infos and infos["_win"][env_idx]:
                        state.win_history.append(bool(infos["win"][env_idx]))

                    if ep_reward > state.best_reward and state.global_step > 0:
                        state.best_reward = ep_reward
                        torch.save(model.state_dict(), self.BEST_MODEL_FILE)

                    # Periodic logging
                    if state.episode % 200 == 0:
                        win_rate = sum(state.win_history) / max(len(state.win_history), 1)
                        avg = float(np.mean(state.rewards_history[-200:]))
                        print(
                            f"Episode {state.episode} | Step {state.global_step} | "
                            f"Phase {state.current_phase} | "
                            f"avg reward (200) = {avg:.2f} | "
                            f"win rate = {win_rate:.2f} | "
                            f"LR = {lr_now:.6f}"
                        )

                    # Save checkpoint
                    if state.episode % 100 == 0:
                        self._save_checkpoint(model, optimizer, state, envs=envs)

                    # Record video
                    if state.episode % self.video_interval == 0:
                        self._record_video_episode(model, state.episode, num_states, num_actions)

                    # Auto-promotion check
                    if check_promotion(state, auto_promote):
                        writer.add_scalar("charts/promotion", state.current_phase, state.global_step)
                        self._save_checkpoint(model, optimizer, state, envs=envs)
                        torch.save(model.state_dict(), self.MODEL_FILE)
                        promoted = True
                        return True

                    return False

                states_t, dones_t, promotion_triggered = collect_rollout(
                    model, envs, buffer, state, self.device,
                    states_t, dones_t, ep_rewards, ep_lengths,
                    num_envs, self.ppo.rollout_steps,
                    on_episode_done=on_ep_done,
                )

                if promotion_triggered:
                    envs.close()
                    self.training_phase = state.current_phase
                    # Auto-enable self-play for phase 3
                    if state.current_phase >= 3 and not self.self_play:
                        self.self_play = True
                        print("  Self-play: auto-enabled for phase 3")
                    envs, num_envs = self._create_envs(state.current_phase, render)
                    states, _ = envs.reset(seed=seed)
                    states_t = torch.tensor(states, dtype=torch.float, device=self.device)
                    dones_t = torch.zeros(num_envs, device=self.device)
                    ep_rewards = np.zeros(num_envs)
                    ep_lengths = np.zeros(num_envs, dtype=int)
                    continue

                # Self-play: freeze current model as opponent every 5000 episodes.
                # The opponent lags behind the training agent, creating an
                # ever-improving sparring partner.
                if (
                    self.self_play
                    and state.phase_episode_count >= 5000
                    and state.phase_episode_count // 5000 != getattr(state, '_last_selfplay_gen', -1)
                ):
                    gen = state.phase_episode_count // 5000
                    state._last_selfplay_gen = gen
                    # Save current model as the new opponent snapshot
                    opp_dir = os.path.join(self.runs_dir, "opponents")
                    os.makedirs(opp_dir, exist_ok=True)
                    opp_path = os.path.join(opp_dir, f"opponent_gen{gen}.pt")
                    torch.save(model.state_dict(), opp_path)
                    # Also save latest model (opponent will load from MODEL_FILE)
                    torch.save(model.state_dict(), self.MODEL_FILE)
                    win_rate = sum(state.win_history) / max(len(state.win_history), 1)
                    print(f"  Self-play: opponent updated to gen{gen} (win rate: {win_rate:.2f}), recreating envs")
                    envs.close()
                    envs, num_envs = self._create_envs(state.current_phase, render)
                    states, _ = envs.reset(seed=seed)
                    states_t = torch.tensor(states, dtype=torch.float, device=self.device)
                    dones_t = torch.zeros(num_envs, device=self.device)
                    ep_rewards = np.zeros(num_envs)
                    ep_lengths = np.zeros(num_envs, dtype=int)
                    continue

                # Compute GAE advantages
                with torch.no_grad():
                    _, _, last_value = model.get_action(states_t)
                buffer.compute_advantages(last_value, dones_t)

                # PPO update
                state.num_updates += 1
                metrics = ppo_update(model, optimizer, buffer, self.ppo)
                log_update_metrics(writer, metrics, buffer, lr_now, state.num_updates, state.global_step)

                # Pool checkpoint
                if (
                    self.env_name == "tank"
                    and state.global_step % self.checkpoint_interval == 0
                    and state.global_step > 0
                ):
                    pool_path = os.path.join(self.checkpoint_dir, f"step_{state.global_step}.pt")
                    torch.save(model.state_dict(), pool_path)

        except KeyboardInterrupt:
            print(f"\nInterrupted at step {state.global_step}, episode {state.episode}.")

        finally:
            self._save_checkpoint(model, optimizer, state, envs=envs)
            torch.save(model.state_dict(), self.MODEL_FILE)
            writer.close()
            envs.close()
            print(f"Saved state at step {state.global_step}, episode {state.episode}.")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _make_env(
        self, render_mode: str | None, training_phase: int, normalize_reward: bool = True,
    ) -> gym.Env:
        """Create a single environment with optional reward normalization.

        Wrapper order (CleanRL convention):
        1. RecordEpisodeStatistics — captures raw episode returns before normalization
        2. NormalizeReward — normalizes rewards using running return variance
        """
        if self.env_name == "tank":
            from tank_env import TankBattleEnv
            opponent_path = self.MODEL_FILE if self.self_play and os.path.exists(self.MODEL_FILE) else None
            env: gym.Env = TankBattleEnv(
                render_mode=render_mode,
                discount_factor=self.discount_factor,
                training_phase=training_phase,
                opponent_model_path=opponent_path,
            )
        else:
            env = gym.make(self.gym_id, render_mode=render_mode)
        if normalize_reward:
            env = gym.wrappers.NormalizeReward(env, gamma=self.ppo.gamma)
        return env

    def _make_vec_envs(self, num_envs: int, phase: int, seed: int) -> gym.vector.VectorEnv:
        """Create AsyncVectorEnv with the given phase.

        When phase > 0, the last env (index num_envs-1) replays a random
        previous phase (~12.5% of data with 8 envs) to prevent catastrophic
        forgetting of earlier skills.
        """
        # Capture only serializable values — NOT self — to avoid pickling weakrefs
        env_name = self.env_name
        gym_id = self.gym_id
        discount_factor = self.discount_factor
        ppo_gamma = self.ppo.gamma

        def make_fn(ph: int = phase) -> gym.Env:
            if env_name == "tank":
                from tank_env import TankBattleEnv
                env: gym.Env = TankBattleEnv(
                    render_mode=None,
                    discount_factor=discount_factor,
                    training_phase=ph,
                )
            else:
                env = gym.make(gym_id, render_mode=None)
            env = gym.wrappers.NormalizeReward(env, gamma=ppo_gamma)
            return env

        env_fns: list[object] = []
        # Reserve last 2 envs (25% of 8) for old-phase replay to prevent
        # catastrophic forgetting of earlier skills.
        replay_count = min(2, num_envs - 1) if phase > 0 else 0
        for i in range(num_envs):
            if i >= num_envs - replay_count:
                replay_phase = random.randint(0, phase - 1)
                print(f"  Env {i}: replaying Phase {replay_phase} (old-phase replay)")
                env_fns.append(lambda ph=replay_phase: make_fn(ph))
            else:
                env_fns.append(lambda ph=phase: make_fn(ph))

        vec_env = gym.vector.AsyncVectorEnv(env_fns)
        self._train_envs_ref = vec_env  # keep reference for saving normalizer state
        return vec_env

    def _record_video_episode(
        self, model: ActorCritic, episode_num: int, num_states: int, num_actions: int
    ) -> None:
        """Run one greedy episode and record video."""
        try:
            env = self._make_env(render_mode="rgb_array", training_phase=self.training_phase, normalize_reward=False)
            env = RecordVideo(
                env,
                video_folder=self.video_dir,
                episode_trigger=lambda ep: True,
                name_prefix=f"ppo-{self.env_name}-phase{self.training_phase}-ep{episode_num}",
            )
            state, _ = env.reset()
            state_t = torch.tensor(state, dtype=torch.float, device=self.device)
            terminated = False
            truncated = False
            while not terminated and not truncated:
                with torch.no_grad():
                    logits, _ = model(state_t.unsqueeze(0))
                    action = logits.argmax(dim=1).item()
                state, _, terminated, truncated, _ = env.step(action)
                state_t = torch.tensor(state, dtype=torch.float, device=self.device)
            env.close()
        except Exception as e:
            print(f"WARNING: Video recording failed for episode {episode_num}: {e}")

    def _get_normalizer_state(self, envs: gym.vector.VectorEnv) -> dict | None:
        """Extract NormalizeReward running stats from vectorized envs."""
        try:
            rms_list = envs.get_attr("return_rms")
            dr_list = envs.get_attr("discounted_reward")
            return {
                "rms_mean": [float(rms.mean) for rms in rms_list],
                "rms_var": [float(rms.var) for rms in rms_list],
                "rms_count": [float(rms.count) for rms in rms_list],
                "discounted_reward": [float(dr[0]) for dr in dr_list],
            }
        except Exception:
            return None

    def _restore_normalizer_state(self, envs: gym.vector.VectorEnv, state: dict) -> None:
        """Restore NormalizeReward running stats into vectorized envs."""
        try:
            from gymnasium.wrappers.utils import RunningMeanStd

            num_envs = envs.num_envs
            # Use the mean of saved stats (all envs see similar data)
            avg_mean = np.mean(state["rms_mean"])
            avg_var = np.mean(state["rms_var"])
            avg_count = np.mean(state["rms_count"])

            rms = RunningMeanStd()
            rms.mean = np.array(avg_mean)
            rms.var = np.array(avg_var)
            rms.count = avg_count
            envs.set_attr("return_rms", rms)

            avg_dr = np.mean(state["discounted_reward"])
            envs.set_attr("discounted_reward", np.array([avg_dr]))
            print(f"Restored reward normalizer state (var={avg_var:.4f}, count={avg_count:.0f})")
        except Exception as e:
            print(f"WARNING: Could not restore normalizer state: {e}")

    def _save_checkpoint(
        self,
        model: ActorCritic,
        optimizer: torch.optim.Adam,
        state: TrainingState,
        envs: gym.vector.VectorEnv | None = None,
    ) -> None:
        """Save full training state for resuming."""
        normalizer_state = self._get_normalizer_state(envs) if envs is not None else None
        torch.save(
            {
                "model_state": model.state_dict(),
                "optimizer_state": optimizer.state_dict(),
                "global_step": state.global_step,
                "episode": state.episode,
                "best_reward": state.best_reward,
                "rewards_history": state.rewards_history[-1000:],
                "num_updates": state.num_updates,
                "current_phase": state.current_phase,
                "phase_episode_count": state.phase_episode_count,
                "win_history": list(state.win_history),
                "normalizer_state": normalizer_state,
                "algo": "ppo",
            },
            self.STATE_FILE,
        )
