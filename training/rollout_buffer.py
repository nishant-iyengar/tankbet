"""Rollout buffer for PPO — stores trajectories and computes GAE advantages.

On-policy: data is collected, used for one training update, then discarded.

Storage convention (matches CleanRL):
    obs[t]      = observation BEFORE taking action at step t
    dones[t]    = done flag from the PREVIOUS transition (True if obs[t] is a reset state)
    actions[t]  = action taken at step t
    rewards[t]  = reward received AFTER taking action at step t
    values[t]   = V(obs[t])
    log_probs[t] = log π(actions[t] | obs[t])
"""

import torch
import numpy as np


class RolloutBuffer:
    """Fixed-size buffer for collecting PPO rollout data across vectorized envs.

    Stores `num_steps` transitions for each of `num_envs` environments.
    After collection, computes GAE advantages and returns shuffled mini-batches.
    """

    def __init__(
        self,
        num_steps: int,
        num_envs: int,
        state_dim: int,
        device: str,
        gamma: float = 0.99,
        gae_lambda: float = 0.95,
    ):
        self.num_steps = num_steps
        self.num_envs = num_envs
        self.state_dim = state_dim
        self.device = device
        self.gamma = gamma
        self.gae_lambda = gae_lambda

        # Pre-allocate storage tensors on CPU (moved to device during training)
        self.obs = torch.zeros((num_steps, num_envs, state_dim))
        self.actions = torch.zeros((num_steps, num_envs), dtype=torch.long)
        self.rewards = torch.zeros((num_steps, num_envs))
        self.dones = torch.zeros((num_steps, num_envs))
        self.values = torch.zeros((num_steps, num_envs))
        self.log_probs = torch.zeros((num_steps, num_envs))

        # Computed after rollout
        self.advantages = torch.zeros((num_steps, num_envs))
        self.returns = torch.zeros((num_steps, num_envs))

        self.step = 0

    def add(
        self,
        obs: torch.Tensor,
        action: torch.Tensor,
        reward: torch.Tensor,
        done: torch.Tensor,
        value: torch.Tensor,
        log_prob: torch.Tensor,
    ) -> None:
        """Store one timestep of data for all envs.

        Args:
            obs: (num_envs, state_dim)
            action: (num_envs,)
            reward: (num_envs,)
            done: (num_envs,) — done flag from PREVIOUS step (1.0 if obs is a reset state)
            value: (num_envs,)
            log_prob: (num_envs,)
        """
        self.obs[self.step] = obs.cpu()
        self.actions[self.step] = action.cpu()
        self.rewards[self.step] = reward.cpu()
        self.dones[self.step] = done.cpu()
        self.values[self.step] = value.cpu()
        self.log_probs[self.step] = log_prob.cpu()
        self.step += 1

    def compute_advantages(self, last_value: torch.Tensor, last_done: torch.Tensor) -> None:
        """Compute GAE advantages and returns (CleanRL-style).

        GAE formula:
            δₜ = rₜ + γ(1 - next_done)V(sₜ₊₁) - V(sₜ)
            Aₜ = Σₗ (γλ)ˡ δₜ₊ₗ

        Where next_done for step t is dones[t+1] (whether the NEXT obs is a reset state).

        Args:
            last_value: V(s_T) for bootstrapping, shape (num_envs,)
            last_done: done flag after last step, shape (num_envs,)
        """
        last_value = last_value.cpu()
        last_done = last_done.cpu()
        last_gae = torch.zeros(self.num_envs)

        for t in reversed(range(self.num_steps)):
            if t == self.num_steps - 1:
                next_non_terminal = 1.0 - last_done
                next_value = last_value
            else:
                next_non_terminal = 1.0 - self.dones[t + 1]
                next_value = self.values[t + 1]

            delta = self.rewards[t] + self.gamma * next_value * next_non_terminal - self.values[t]
            last_gae = delta + self.gamma * self.gae_lambda * next_non_terminal * last_gae
            self.advantages[t] = last_gae

        self.returns = self.advantages + self.values

    def get_batches(
        self, num_minibatches: int
    ) -> list[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]]:
        """Flatten rollout and return shuffled mini-batches on device.

        Returns list of (obs, actions, old_log_probs, advantages, returns, values) tuples.
        """
        batch_size = self.num_steps * self.num_envs
        minibatch_size = batch_size // num_minibatches

        # Flatten (steps, envs, ...) → (batch, ...)
        b_obs = self.obs.reshape(batch_size, self.state_dim).to(self.device)
        b_actions = self.actions.reshape(batch_size).to(self.device)
        b_log_probs = self.log_probs.reshape(batch_size).to(self.device)
        b_advantages = self.advantages.reshape(batch_size).to(self.device)
        b_returns = self.returns.reshape(batch_size).to(self.device)
        b_values = self.values.reshape(batch_size).to(self.device)

        # Normalize advantages
        b_advantages = (b_advantages - b_advantages.mean()) / (b_advantages.std() + 1e-8)

        # Shuffle indices
        indices = np.arange(batch_size)
        np.random.shuffle(indices)

        batches: list[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]] = []
        for start in range(0, batch_size, minibatch_size):
            end = start + minibatch_size
            mb_indices = torch.tensor(indices[start:end], dtype=torch.long, device=self.device)
            batches.append((
                b_obs[mb_indices],
                b_actions[mb_indices],
                b_log_probs[mb_indices],
                b_advantages[mb_indices],
                b_returns[mb_indices],
                b_values[mb_indices],
            ))

        return batches

    def reset(self) -> None:
        """Reset step counter for next rollout (tensors are overwritten in-place)."""
        self.step = 0
