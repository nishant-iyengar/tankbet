import torch
from torch import nn
import torch.nn.functional as F


class DQN(nn.Module):
    """
    Dueling DQN: splits into Value and Advantage streams after shared layers.
    Q(s,a) = V(s) + A(s,a) - mean(A(s,a))

    Based on johnnycode8/dqn_pytorch, extended with a second shared layer
    for the larger state space of our tank game.
    """

    def __init__(self, state_dim: int, action_dim: int, hidden_dim: int = 256,
                 enable_dueling: bool = True):
        super().__init__()
        self.enable_dueling = enable_dueling

        # Shared feature layers (3 layers for 162-dim observation space)
        self.fc1 = nn.Linear(state_dim, hidden_dim)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)
        self.fc3 = nn.Linear(hidden_dim, hidden_dim)

        if self.enable_dueling:
            # Value stream: state → scalar V(s)
            self.fc_value = nn.Linear(hidden_dim, 128)
            self.value = nn.Linear(128, 1)

            # Advantage stream: state → A(s,a) per action
            self.fc_advantages = nn.Linear(hidden_dim, 128)
            self.advantages = nn.Linear(128, action_dim)
        else:
            self.output = nn.Linear(hidden_dim, action_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))
        x = F.relu(self.fc3(x))

        if self.enable_dueling:
            v = F.relu(self.fc_value(x))
            V = self.value(v)                                    # (batch, 1)

            a = F.relu(self.fc_advantages(x))
            A = self.advantages(a)                               # (batch, action_dim)

            Q = V + A - torch.mean(A, dim=1, keepdim=True)      # (batch, action_dim)
        else:
            Q = self.output(x)

        return Q
