"""DDQN Trainer — Double DQN + Dueling DQN + PER training loop.

Extracted from main.py. Supports single-env (CartPole/Lunar/render) and
vectorized multi-env (Tank) training with curriculum phases.
"""

from __future__ import annotations

import itertools
import os
import random
from collections import deque

import gymnasium as gym
import numpy as np
import torch
from gymnasium.wrappers import RecordVideo
from torch import nn
from torch.utils.tensorboard import SummaryWriter

from dqn import DQN
from experience_replay import PrioritizedReplayMemory, ReplayMemory


def linear_schedule(start_e: float, end_e: float, duration: int, t: int) -> float:
    """Linear epsilon schedule (matches CleanRL pattern)."""
    slope = (end_e - start_e) / duration
    return max(slope * t + start_e, end_e)


class DDQNTrainer:
    """Double DQN + Dueling DQN agent with PER support."""

    def __init__(
        self,
        env_name: str,
        gym_id: str,
        hidden_dim: int,
        total_timesteps: int,
        learning_rate: float,
        num_envs: int,
        replay_memory_size: int,
        learning_starts: int,
        network_sync_rate: int,
        exploration_fraction: float,
        enable_dueling_dqn: bool,
        use_per: bool,
        per_alpha: float,
        per_beta_start: float,
        runs_dir: str,
        checkpoint_dir: str,
        video_dir: str,
        model_file: str,
        best_model_file: str,
        state_file: str,
        video_interval: int,
        checkpoint_interval: int,
        device: str,
        discount_factor: float = 0.99,
        self_play: bool = False,
        training_phase: int = 0,
    ):
        self.env_name = env_name
        self.gym_id = gym_id
        self.hidden_dim = hidden_dim
        self.total_timesteps = total_timesteps
        self.learning_rate = learning_rate
        self.num_envs = num_envs
        self.replay_memory_size = replay_memory_size
        self.learning_starts = learning_starts
        self.network_sync_rate = network_sync_rate
        self.exploration_fraction = exploration_fraction
        self.enable_dueling_dqn = enable_dueling_dqn
        self.use_per = use_per
        self.per_alpha = per_alpha
        self.per_beta_start = per_beta_start
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
        self.self_play = self_play
        self.training_phase = training_phase

        # Fixed hyperparams
        self.mini_batch_size = 64
        self.epsilon_start = 1.0
        self.epsilon_end = 0.05
        self.train_frequency = 4
        self.enable_double_dqn = True

        self.optimizer: torch.optim.Adam | None = None

    def _make_env(self, render_mode: str | None, training_phase: int, opponent_model_path: str | None = None) -> gym.Env:
        """Create a single environment."""
        if self.env_name == "tank":
            from tank_env import TankBattleEnv
            return TankBattleEnv(
                render_mode=render_mode,
                discount_factor=self.discount_factor,
                opponent_model_path=opponent_model_path,
                training_phase=training_phase,
            )
        else:
            return gym.make(self.gym_id, render_mode=render_mode)

    def run(
        self, is_training: bool = True, render: bool = False, resume: bool = False,
        auto_promote: bool = False,
    ) -> None:
        num_envs = self.num_envs if is_training and not render else 1

        if num_envs > 1:
            self._run_vectorized(resume=resume, auto_promote=auto_promote)
        else:
            self._run_single(is_training=is_training, render=render, resume=resume)

    # ------------------------------------------------------------------
    # Single-env training/eval loop
    # ------------------------------------------------------------------
    def _run_single(
        self, is_training: bool = True, render: bool = False, resume: bool = False
    ) -> None:
        seed = 42
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)

        start_episode = 0
        global_step = 0

        checkpoint = None
        if is_training and resume and os.path.exists(self.STATE_FILE):
            checkpoint = torch.load(
                self.STATE_FILE, map_location=self.device, weights_only=False
            )
            start_episode = checkpoint["episode"]
            global_step = checkpoint["global_step"]

        # Environment setup
        render_mode = "human" if render else ("rgb_array" if is_training else None)
        env = self._make_env(render_mode=render_mode, training_phase=self.training_phase)

        if is_training and not render:
            try:
                env = RecordVideo(
                    env,
                    video_folder=self.video_dir,
                    episode_trigger=lambda ep: (ep + start_episode) % self.video_interval == 0,
                    name_prefix=f"training-{self.env_name}",
                )
            except Exception as e:
                print(f"WARNING: RecordVideo failed ({e}). Continuing without video recording.")

        num_states: int = env.observation_space.shape[0]  # type: ignore[index]
        num_actions: int = env.action_space.n  # type: ignore[attr-defined]

        policy_dqn = DQN(num_states, num_actions, self.hidden_dim, self.enable_dueling_dqn).to(self.device)

        if is_training:
            memory: ReplayMemory | PrioritizedReplayMemory
            if self.use_per:
                memory = PrioritizedReplayMemory(self.replay_memory_size, alpha=self.per_alpha)
            else:
                memory = ReplayMemory(self.replay_memory_size)
            writer = SummaryWriter(os.path.join(self.runs_dir, "tb_logs"))

            target_dqn = DQN(num_states, num_actions, self.hidden_dim, self.enable_dueling_dqn).to(self.device)
            target_dqn.load_state_dict(policy_dqn.state_dict())

            self.optimizer = torch.optim.Adam(policy_dqn.parameters(), lr=self.learning_rate)
            best_reward = -float("inf")
            rewards_history: list[float] = []

            if checkpoint is not None:
                policy_dqn.load_state_dict(checkpoint["model_state"])
                target_dqn.load_state_dict(checkpoint["target_state"])
                self.optimizer.load_state_dict(checkpoint["optimizer_state"])
                best_reward = checkpoint["best_reward"]
                rewards_history = checkpoint["rewards_history"]
                print(f"Resumed from step {global_step}, episode {start_episode}")
            elif resume:
                print(f"No checkpoint found at {self.STATE_FILE}. Starting fresh.")
        else:
            if not os.path.exists(self.MODEL_FILE):
                print(f"No trained model found at {self.MODEL_FILE}. Train first.")
                env.close()
                return
            eval_state = torch.load(self.MODEL_FILE, map_location=self.device)
            policy_dqn.load_state_dict(eval_state)
            policy_dqn.eval()

        episode = start_episode
        first_episode = episode
        try:
            for episode in itertools.count(start=first_episode):
                if episode == first_episode:
                    env.action_space.seed(seed)
                    env.observation_space.seed(seed)
                    state, _ = env.reset(seed=seed)
                else:
                    state, _ = env.reset()

                state = torch.tensor(state, dtype=torch.float, device=self.device)
                terminated = False
                truncated = False
                episode_reward = 0.0
                episode_length = 0

                while not terminated and not truncated:
                    if is_training:
                        epsilon = linear_schedule(
                            self.epsilon_start, self.epsilon_end,
                            int(self.exploration_fraction * self.total_timesteps),
                            global_step,
                        )
                    else:
                        epsilon = 0.0

                    if is_training and random.random() < epsilon:
                        action = env.action_space.sample()
                        action = torch.tensor(action, dtype=torch.int64, device=self.device)
                    else:
                        with torch.no_grad():
                            action = policy_dqn(state.unsqueeze(dim=0)).squeeze().argmax()

                    new_state, reward, terminated, truncated, info = env.step(action.item())
                    episode_reward += float(reward)
                    episode_length += 1

                    new_state = torch.tensor(new_state, dtype=torch.float, device=self.device)
                    reward_t = torch.tensor(reward, dtype=torch.float, device=self.device)

                    if is_training:
                        memory.append((
                            state.detach().cpu(),
                            action.detach().cpu(),
                            new_state.detach().cpu(),
                            reward_t.detach().cpu(),
                            terminated,
                        ))
                        global_step += 1

                        if (
                            global_step > self.learning_starts
                            and len(memory) >= self.mini_batch_size
                            and global_step % self.train_frequency == 0
                        ):
                            self._train_step(memory, policy_dqn, target_dqn, writer, global_step)

                        if (
                            global_step > self.learning_starts
                            and global_step % self.network_sync_rate == 0
                        ):
                            target_dqn.load_state_dict(policy_dqn.state_dict())

                        if (
                            self.env_name == "tank"
                            and global_step % self.checkpoint_interval == 0
                            and global_step > 0
                        ):
                            pool_path = os.path.join(self.checkpoint_dir, f"step_{global_step}.pt")
                            torch.save(policy_dqn.state_dict(), pool_path)

                    state = new_state

                    if is_training and global_step >= self.total_timesteps:
                        truncated = True

                if is_training:
                    rewards_history.append(episode_reward)
                    writer.add_scalar("charts/episode_reward", episode_reward, global_step)
                    writer.add_scalar("charts/episode_length", episode_length, global_step)

                    if episode_reward > best_reward and global_step > self.learning_starts:
                        best_reward = episode_reward
                        torch.save(policy_dqn.state_dict(), self.BEST_MODEL_FILE)

                    if episode % 100 == 0 and episode > 0:
                        avg = float(np.mean(rewards_history[-100:]))
                        print(
                            f"Episode {episode} | Step {global_step} | "
                            f"avg reward (100) = {avg:.2f} | "
                            f"\u03b5 = {epsilon:.4f}"
                        )

                    if episode % 50 == 0 and episode > 0:
                        self._save_checkpoint(
                            policy_dqn, target_dqn, global_step, episode,
                            best_reward, rewards_history,
                        )

                    if global_step >= self.total_timesteps:
                        break
                else:
                    print(
                        f"Episode {episode} | reward = {episode_reward:.2f} | "
                        f"length = {episode_length}"
                    )
                    if episode >= 9:
                        break

        except KeyboardInterrupt:
            if is_training:
                print(f"\nInterrupted at step {global_step}, episode {episode}.")

        finally:
            if is_training:
                self._save_checkpoint(
                    policy_dqn, target_dqn, global_step, episode,
                    best_reward, rewards_history,
                )
                torch.save(policy_dqn.state_dict(), self.MODEL_FILE)
                writer.close()
                print(f"Saved state at step {global_step}, episode {episode}.")
            env.close()

    # ------------------------------------------------------------------
    # Vectorized training loop (multi-env, for tank)
    # ------------------------------------------------------------------
    def _run_vectorized(self, resume: bool = False, auto_promote: bool = False) -> None:
        num_envs = self.num_envs
        seed = 42
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)

        current_phase = self.training_phase
        phase_episode_count = 0
        win_history: deque[bool] = deque(maxlen=200)
        epsilon_reset_step = 0
        phase_learning_starts = self.learning_starts

        # Get dims
        _tmp_env = self._make_env(render_mode=None, training_phase=current_phase)
        num_states: int = _tmp_env.observation_space.shape[0]  # type: ignore[index]
        num_actions: int = _tmp_env.action_space.n  # type: ignore[attr-defined]
        _tmp_env.close()

        policy_dqn = DQN(num_states, num_actions, self.hidden_dim, self.enable_dueling_dqn).to(self.device)
        target_dqn = DQN(num_states, num_actions, self.hidden_dim, self.enable_dueling_dqn).to(self.device)
        target_dqn.load_state_dict(policy_dqn.state_dict())

        memory: ReplayMemory | PrioritizedReplayMemory
        if self.use_per:
            memory = PrioritizedReplayMemory(self.replay_memory_size, alpha=self.per_alpha)
        else:
            memory = ReplayMemory(self.replay_memory_size)
        writer = SummaryWriter(os.path.join(self.runs_dir, "tb_logs"))

        self.optimizer = torch.optim.Adam(policy_dqn.parameters(), lr=self.learning_rate)
        global_step = 0
        episode = 0
        best_reward = -float("inf")
        rewards_history: list[float] = []

        # Resume
        if resume and os.path.exists(self.STATE_FILE):
            checkpoint = torch.load(self.STATE_FILE, map_location=self.device, weights_only=False)
            policy_dqn.load_state_dict(checkpoint["model_state"])
            target_dqn.load_state_dict(checkpoint["target_state"])
            self.optimizer.load_state_dict(checkpoint["optimizer_state"])
            global_step = checkpoint["global_step"]
            episode = checkpoint["episode"]
            best_reward = checkpoint["best_reward"]
            rewards_history = checkpoint["rewards_history"]
            if "current_phase" in checkpoint and checkpoint["current_phase"] is not None:
                current_phase = checkpoint["current_phase"]
                self.training_phase = current_phase
                epsilon_reset_step = checkpoint.get("epsilon_reset_step", 0)
                self.epsilon_start = checkpoint.get("epsilon_start", 1.0)
                phase_episode_count = checkpoint.get("phase_episode_count", 0)
                saved_wins = checkpoint.get("win_history", [])
                win_history = deque(saved_wins, maxlen=200)
                phase_learning_starts = checkpoint.get("phase_learning_starts", self.learning_starts)
            print(f"Resumed from step {global_step}, episode {episode}, phase {current_phase}")
        elif resume:
            print(f"No checkpoint found at {self.STATE_FILE}. Starting fresh.")

        # Create vectorized envs
        opp_path = self.BEST_MODEL_FILE if self.self_play and os.path.exists(self.BEST_MODEL_FILE) else None
        if opp_path:
            print(f"Self-play: opponent loaded from {opp_path}")

        def make_env_fn(idx: int, phase: int = current_phase) -> gym.Env:
            return self._make_env(render_mode="rgb_array", training_phase=phase, opponent_model_path=opp_path)

        envs = gym.vector.AsyncVectorEnv(
            [lambda idx=i, ph=current_phase: make_env_fn(idx, ph) for i in range(num_envs)]
        )
        print(f"Vectorized training: {num_envs} parallel environments")

        states, _ = envs.reset(seed=seed)
        states_t = torch.tensor(states, dtype=torch.float, device=self.device)

        ep_rewards = np.zeros(num_envs)
        ep_lengths = np.zeros(num_envs, dtype=int)

        try:
            while global_step < self.total_timesteps:
                epsilon = linear_schedule(
                    self.epsilon_start, self.epsilon_end,
                    int(self.exploration_fraction * self.total_timesteps),
                    global_step - epsilon_reset_step,
                )

                with torch.no_grad():
                    greedy_actions = policy_dqn(states_t).argmax(dim=1).cpu().numpy()
                actions = np.array([
                    envs.single_action_space.sample() if random.random() < epsilon else greedy_actions[i]
                    for i in range(num_envs)
                ])

                new_states, rewards, terminated, truncated, infos = envs.step(actions)

                for i in range(num_envs):
                    done = terminated[i] or truncated[i]
                    if done and "final_observation" in infos and infos["final_observation"][i] is not None:
                        real_new_state = infos["final_observation"][i]
                    else:
                        real_new_state = new_states[i]

                    memory.append((
                        torch.tensor(states[i], dtype=torch.float),
                        torch.tensor(actions[i], dtype=torch.int64),
                        torch.tensor(real_new_state, dtype=torch.float),
                        torch.tensor(rewards[i], dtype=torch.float),
                        bool(terminated[i]),
                    ))

                    ep_rewards[i] += rewards[i]
                    ep_lengths[i] += 1
                    global_step += 1

                    if done:
                        episode += 1
                        phase_episode_count += 1
                        rewards_history.append(float(ep_rewards[i]))
                        writer.add_scalar("charts/episode_reward", ep_rewards[i], global_step)
                        writer.add_scalar("charts/episode_length", ep_lengths[i], global_step)
                        writer.add_scalar("charts/phase", current_phase, global_step)

                        if "win" in infos and infos["_win"][i]:
                            win_history.append(bool(infos["win"][i]))

                        if ep_rewards[i] > best_reward and global_step > self.learning_starts:
                            best_reward = float(ep_rewards[i])
                            torch.save(policy_dqn.state_dict(), self.BEST_MODEL_FILE)

                        if episode % 200 == 0:
                            win_rate = sum(win_history) / max(len(win_history), 1)
                            avg = float(np.mean(rewards_history[-200:]))
                            print(
                                f"Episode {episode} | Step {global_step} | "
                                f"Phase {current_phase} | "
                                f"avg reward (200) = {avg:.2f} | "
                                f"win rate = {win_rate:.2f} | "
                                f"\u03b5 = {epsilon:.4f}"
                            )

                        if episode % 100 == 0:
                            self._save_checkpoint(
                                policy_dqn, target_dqn, global_step, episode,
                                best_reward, rewards_history,
                                current_phase=current_phase,
                                epsilon_reset_step=epsilon_reset_step,
                                epsilon_start=self.epsilon_start,
                                phase_episode_count=phase_episode_count,
                                win_history=win_history,
                                phase_learning_starts=phase_learning_starts,
                            )

                        if episode % self.video_interval == 0:
                            self._record_video_episode(policy_dqn, episode, num_states, num_actions)

                        # Auto-promotion
                        if auto_promote and current_phase < 3:
                            from phase_config import PHASE_CONFIGS
                            phase_cfg = PHASE_CONFIGS[current_phase]
                            if (
                                phase_episode_count >= phase_cfg.promote_min_episodes
                                and len(win_history) >= 200
                            ):
                                win_rate = sum(win_history) / len(win_history)
                                if win_rate >= phase_cfg.promote_win_rate:
                                    current_phase += 1
                                    print(f"\n{'=' * 60}")
                                    print(f"AUTO-PROMOTE: Phase {current_phase - 1} → {current_phase}")
                                    print(f"Win rate: {win_rate:.2f} >= {phase_cfg.promote_win_rate}")
                                    print(f"{'=' * 60}\n")
                                    writer.add_scalar("charts/promotion", current_phase, global_step)

                                    phase_episode_count = 0
                                    win_history.clear()
                                    self.epsilon_start = 0.3
                                    epsilon_reset_step = global_step
                                    phase_learning_starts = global_step + self.learning_starts

                                    if isinstance(memory, PrioritizedReplayMemory):
                                        memory = PrioritizedReplayMemory(self.replay_memory_size, alpha=self.per_alpha)
                                    else:
                                        memory = ReplayMemory(self.replay_memory_size)

                                    self._save_checkpoint(
                                        policy_dqn, target_dqn, global_step, episode,
                                        best_reward, rewards_history,
                                        current_phase=current_phase,
                                        epsilon_reset_step=epsilon_reset_step,
                                        epsilon_start=self.epsilon_start,
                                        phase_episode_count=phase_episode_count,
                                        win_history=win_history,
                                        phase_learning_starts=phase_learning_starts,
                                    )
                                    torch.save(policy_dqn.state_dict(), self.MODEL_FILE)

                                    envs.close()
                                    self.training_phase = current_phase
                                    envs = gym.vector.AsyncVectorEnv(
                                        [lambda idx=j, ph=current_phase: make_env_fn(idx, ph) for j in range(num_envs)]
                                    )
                                    states, _ = envs.reset(seed=seed)
                                    states_t = torch.tensor(states, dtype=torch.float, device=self.device)
                                    ep_rewards = np.zeros(num_envs)
                                    ep_lengths = np.zeros(num_envs, dtype=int)
                                    break

                        ep_rewards[i] = 0.0
                        ep_lengths[i] = 0
                else:
                    states = new_states
                    states_t = torch.tensor(states, dtype=torch.float, device=self.device)

                # Training step
                if (
                    global_step > phase_learning_starts
                    and len(memory) >= self.mini_batch_size
                    and global_step % self.train_frequency == 0
                ):
                    self._train_step(
                        memory, policy_dqn, target_dqn, writer, global_step,
                        epsilon_reset_step=epsilon_reset_step,
                        phase_learning_starts=phase_learning_starts,
                    )

                # Sync target
                if (
                    global_step > phase_learning_starts
                    and global_step % self.network_sync_rate == 0
                ):
                    target_dqn.load_state_dict(policy_dqn.state_dict())

                # Pool checkpoint
                if (
                    self.env_name == "tank"
                    and global_step % self.checkpoint_interval == 0
                    and global_step > 0
                ):
                    pool_path = os.path.join(self.checkpoint_dir, f"step_{global_step}.pt")
                    torch.save(policy_dqn.state_dict(), pool_path)

        except KeyboardInterrupt:
            print(f"\nInterrupted at step {global_step}, episode {episode}.")

        finally:
            self._save_checkpoint(
                policy_dqn, target_dqn, global_step, episode,
                best_reward, rewards_history,
                current_phase=current_phase,
                epsilon_reset_step=epsilon_reset_step,
                epsilon_start=self.epsilon_start,
                phase_episode_count=phase_episode_count,
                win_history=win_history,
                phase_learning_starts=phase_learning_starts,
            )
            torch.save(policy_dqn.state_dict(), self.MODEL_FILE)
            writer.close()
            envs.close()
            print(f"Saved state at step {global_step}, episode {episode}.")

    # ------------------------------------------------------------------
    # Video recording
    # ------------------------------------------------------------------
    def _record_video_episode(
        self, policy_dqn: DQN, episode_num: int, num_states: int, num_actions: int
    ) -> None:
        try:
            env = self._make_env(render_mode="rgb_array", training_phase=self.training_phase)
            env = RecordVideo(
                env,
                video_folder=self.video_dir,
                episode_trigger=lambda ep: True,
                name_prefix=f"training-{self.env_name}-episode-{episode_num}",
            )
            state, _ = env.reset()
            state_t = torch.tensor(state, dtype=torch.float, device=self.device)
            terminated = False
            truncated = False
            while not terminated and not truncated:
                with torch.no_grad():
                    action = policy_dqn(state_t.unsqueeze(0)).squeeze().argmax().item()
                state, _, terminated, truncated, _ = env.step(action)
                state_t = torch.tensor(state, dtype=torch.float, device=self.device)
            env.close()
        except Exception as e:
            print(f"WARNING: Video recording failed for episode {episode_num}: {e}")

    # ------------------------------------------------------------------
    # Training step
    # ------------------------------------------------------------------
    def _train_step(
        self,
        memory: ReplayMemory | PrioritizedReplayMemory,
        policy_dqn: DQN,
        target_dqn: DQN,
        writer: SummaryWriter,
        global_step: int,
        epsilon_reset_step: int = 0,
        phase_learning_starts: int = 0,
    ) -> None:
        if isinstance(memory, PrioritizedReplayMemory):
            effective_starts = phase_learning_starts if phase_learning_starts > 0 else self.learning_starts
            training_steps = self.total_timesteps - effective_starts
            progress = min(
                (global_step - effective_starts) / max(training_steps, 1), 1.0,
            )
            beta = self.per_beta_start + (1.0 - self.per_beta_start) * progress
            mini_batch, weights, indices = memory.sample(self.mini_batch_size, beta)
            weights_t = torch.tensor(weights, dtype=torch.float32, device=self.device)
            loss, td_errors = self._optimize(mini_batch, policy_dqn, target_dqn, weights=weights_t)
            memory.update_priorities(indices, td_errors)
        else:
            mini_batch = memory.sample(self.mini_batch_size)
            loss, _ = self._optimize(mini_batch, policy_dqn, target_dqn)

        if global_step % 100 == 0:
            writer.add_scalar("losses/td_loss", loss, global_step)
            epsilon = linear_schedule(
                self.epsilon_start, self.epsilon_end,
                int(self.exploration_fraction * self.total_timesteps),
                global_step - epsilon_reset_step,
            )
            writer.add_scalar("charts/epsilon", epsilon, global_step)

            with torch.no_grad():
                batch_states = torch.stack([t[0] for t in mini_batch]).to(self.device)
                mean_q = policy_dqn(batch_states).max(dim=1)[0].mean()
                writer.add_scalar("charts/mean_q", mean_q.item(), global_step)

            if isinstance(memory, PrioritizedReplayMemory):
                writer.add_scalar(
                    "charts/mean_priority", memory.tree.total / len(memory), global_step,
                )

    def _save_checkpoint(
        self,
        policy_dqn: DQN,
        target_dqn: DQN,
        global_step: int,
        episode: int,
        best_reward: float,
        rewards_history: list[float],
        *,
        current_phase: int | None = None,
        epsilon_reset_step: int = 0,
        epsilon_start: float = 1.0,
        phase_episode_count: int = 0,
        win_history: deque[bool] | None = None,
        phase_learning_starts: int = 0,
    ) -> None:
        assert self.optimizer is not None
        torch.save(
            {
                "model_state": policy_dqn.state_dict(),
                "target_state": target_dqn.state_dict(),
                "optimizer_state": self.optimizer.state_dict(),
                "global_step": global_step,
                "episode": episode,
                "best_reward": best_reward,
                "rewards_history": rewards_history[-1000:],
                "current_phase": current_phase,
                "epsilon_reset_step": epsilon_reset_step,
                "epsilon_start": epsilon_start,
                "phase_episode_count": phase_episode_count,
                "win_history": list(win_history) if win_history is not None else [],
                "phase_learning_starts": phase_learning_starts,
                "algo": "ddqn",
            },
            self.STATE_FILE,
        )

    def _optimize(
        self,
        mini_batch: list[tuple],
        policy_dqn: DQN,
        target_dqn: DQN,
        weights: torch.Tensor | None = None,
    ) -> tuple[float, np.ndarray]:
        assert self.optimizer is not None

        states, actions, new_states, rewards, dones = zip(*mini_batch)

        states_t = torch.stack(list(states)).to(self.device)
        actions_t = torch.stack(list(actions)).to(self.device)
        new_states_t = torch.stack(list(new_states)).to(self.device)
        rewards_t = torch.stack(list(rewards)).to(self.device)
        dones_t = torch.tensor(dones, dtype=torch.float32, device=self.device)

        with torch.no_grad():
            if self.enable_double_dqn:
                best_actions = policy_dqn(new_states_t).argmax(dim=1)
                target_q = rewards_t + (1 - dones_t) * self.discount_factor * (
                    target_dqn(new_states_t)
                    .gather(dim=1, index=best_actions.unsqueeze(dim=1))
                    .squeeze()
                )
            else:
                target_q = (
                    rewards_t
                    + (1 - dones_t) * self.discount_factor
                    * target_dqn(new_states_t).max(dim=1)[0]
                )

        current_q = (
            policy_dqn(states_t)
            .gather(dim=1, index=actions_t.unsqueeze(dim=1))
            .squeeze()
        )

        td_errors = (current_q - target_q).detach().cpu().numpy()

        per_sample_loss = nn.functional.smooth_l1_loss(current_q, target_q, reduction="none")
        if weights is not None:
            per_sample_loss = per_sample_loss * weights
        loss = per_sample_loss.mean()

        self.optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(policy_dqn.parameters(), 10.0)
        self.optimizer.step()

        return loss.item(), td_errors
