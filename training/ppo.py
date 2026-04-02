"""ActorCritic network for PPO.

Two architecture modes:
  - separate=True (default): Separate actor and critic networks with Tanh activations.
    Used for Tank — prevents gradient interference between actor and critic.
  - separate=False: Shared trunk with actor/critic heads. ReLU activations.
    Faster for small envs (CartPole, LunarLander).

Orthogonal weight initialization following CleanRL best practices.
"""

import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical


def _layer_init(layer: nn.Linear, std: float = np.sqrt(2), bias_const: float = 0.0) -> nn.Linear:
    """Orthogonal initialization (standard for PPO, see CleanRL)."""
    nn.init.orthogonal_(layer.weight, std)
    nn.init.constant_(layer.bias, bias_const)
    return layer


class ActorCritic(nn.Module):
    """Actor-Critic network for PPO with discrete action space."""

    def __init__(self, state_dim: int, action_dim: int, hidden_dim: int = 64, separate: bool = True):
        super().__init__()
        self.separate = separate

        if separate:
            # Separate actor and critic networks — 2×hidden Tanh
            self.critic_net = nn.Sequential(
                _layer_init(nn.Linear(state_dim, hidden_dim)),
                nn.Tanh(),
                _layer_init(nn.Linear(hidden_dim, hidden_dim)),
                nn.Tanh(),
                _layer_init(nn.Linear(hidden_dim, 1), std=1.0),
            )
            self.actor_net = nn.Sequential(
                _layer_init(nn.Linear(state_dim, hidden_dim)),
                nn.Tanh(),
                _layer_init(nn.Linear(hidden_dim, hidden_dim)),
                nn.Tanh(),
                _layer_init(nn.Linear(hidden_dim, action_dim), std=0.01),
            )
        else:
            # Shared trunk with separate heads (better for large state spaces)
            self.shared = nn.Sequential(
                _layer_init(nn.Linear(state_dim, hidden_dim)),
                nn.ReLU(),
                _layer_init(nn.Linear(hidden_dim, hidden_dim)),
                nn.ReLU(),
                _layer_init(nn.Linear(hidden_dim, hidden_dim)),
                nn.ReLU(),
            )
            self.actor = _layer_init(nn.Linear(hidden_dim, action_dim), std=0.01)
            self.critic = _layer_init(nn.Linear(hidden_dim, 1), std=1.0)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Forward pass returning (logits, value)."""
        if self.separate:
            logits = self.actor_net(x)
            value = self.critic_net(x).squeeze(-1)
        else:
            features = self.shared(x)
            logits = self.actor(features)
            value = self.critic(features).squeeze(-1)
        return logits, value

    def get_action(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Sample action from policy for rollout collection.

        Returns:
            (action, log_prob, value) — all tensors
        """
        logits, value = self.forward(x)
        dist = Categorical(logits=logits)
        action = dist.sample()
        log_prob = dist.log_prob(action)
        return action, log_prob, value

    def evaluate(
        self, x: torch.Tensor, actions: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Evaluate actions for PPO training update.

        Returns:
            (log_probs, values, entropy) — for computing PPO loss
        """
        logits, value = self.forward(x)
        dist = Categorical(logits=logits)
        log_probs = dist.log_prob(actions)
        entropy = dist.entropy()
        return log_probs, value, entropy
