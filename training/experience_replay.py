from collections import deque
import random

import numpy as np


class ReplayMemory:
    """
    Simple uniform experience replay buffer using a deque.
    From johnnycode8/dqn_pytorch/experience_replay.py.

    Stores transitions as (state, action, new_state, reward, terminated) tuples.

    IMPORTANT: The fifth element MUST be `terminated` (not `truncated`, not
    `terminated or truncated`). Only true terminal states (game over) should
    zero the bootstrap value in the Bellman target. Time-limit truncations
    still have future value — zeroing them is a well-known bug that causes
    the agent to incorrectly learn that late-game states are worthless.

    Reference: https://farama.org/Gymnasium-Terminated-Truncated-Step-API

    Deque automatically evicts oldest transitions when full (FIFO).
    """

    def __init__(self, maxlen: int, seed: int | None = None):
        self.memory: deque[tuple] = deque([], maxlen=maxlen)
        # Use a LOCAL Random instance — never seed the global random state,
        # which would interfere with epsilon-greedy and other random calls.
        self._rng = random.Random(seed)

    def append(self, transition: tuple) -> None:
        self.memory.append(transition)

    def sample(self, sample_size: int) -> list[tuple]:
        return self._rng.sample(self.memory, sample_size)

    def trim(self, keep: int) -> None:
        """Keep only the most recent `keep` transitions."""
        if keep >= len(self.memory):
            return
        maxlen = self.memory.maxlen
        recent = list(self.memory)[-keep:]
        self.memory = deque(recent, maxlen=maxlen)

    def __len__(self) -> int:
        return len(self.memory)


class SumTree:
    """Binary tree for O(log N) proportional sampling.

    Leaves hold priority values; internal nodes hold sums of children.
    Array layout: nodes[0] is root, leaves start at index (capacity - 1).
    Total array size = 2 * capacity - 1.
    """

    def __init__(self, capacity: int):
        self.capacity = capacity
        self.tree = np.zeros(2 * capacity - 1, dtype=np.float64)
        self.write_idx = 0
        self.size = 0

    @property
    def total(self) -> float:
        return float(self.tree[0])

    def update(self, leaf_idx: int, priority: float) -> None:
        """Set priority for a leaf and propagate the change up."""
        tree_idx = leaf_idx + self.capacity - 1
        delta = priority - self.tree[tree_idx]
        self.tree[tree_idx] = priority
        while tree_idx > 0:
            tree_idx = (tree_idx - 1) // 2
            self.tree[tree_idx] += delta

    def add(self, priority: float) -> int:
        """Add a new priority value at the next write position. Returns leaf index."""
        leaf_idx = self.write_idx
        self.update(leaf_idx, priority)
        self.write_idx = (self.write_idx + 1) % self.capacity
        self.size = min(self.size + 1, self.capacity)
        return leaf_idx

    def sample(self, value: float) -> int:
        """Traverse the tree to find the leaf index for a given value in [0, total)."""
        idx = 0  # start at root
        while True:
            left = 2 * idx + 1
            right = left + 1
            if left >= len(self.tree):
                # reached a leaf
                break
            if value <= self.tree[left]:
                idx = left
            else:
                value -= self.tree[left]
                idx = right
        leaf_idx = idx - (self.capacity - 1)
        return leaf_idx


class PrioritizedReplayMemory:
    """Proportional Prioritized Experience Replay (Schaul et al. 2016).

    Stores transitions with priorities based on TD error magnitude.
    New transitions get max priority so they are sampled at least once.
    """

    def __init__(self, maxlen: int, alpha: float = 0.6, epsilon: float = 1e-5):
        self.alpha = alpha
        self.epsilon = epsilon
        self.tree = SumTree(maxlen)
        self.data: list[tuple | None] = [None] * maxlen
        self.max_priority = 1.0

    def append(self, transition: tuple) -> None:
        """Store a transition with max priority."""
        leaf_idx = self.tree.add(self.max_priority**self.alpha)
        self.data[leaf_idx] = transition

    def sample(
        self, batch_size: int, beta: float
    ) -> tuple[list[tuple], np.ndarray, list[int]]:
        """Proportional sampling with importance-sampling weight correction.

        Returns (transitions, weights, leaf_indices).
        """
        indices: list[int] = []
        priorities = np.zeros(batch_size, dtype=np.float64)
        segment = self.tree.total / batch_size

        for i in range(batch_size):
            low = segment * i
            high = segment * (i + 1)
            value = random.uniform(low, high)
            leaf_idx = self.tree.sample(value)
            indices.append(leaf_idx)
            # Priority is stored in tree at tree_idx = leaf_idx + capacity - 1
            priorities[i] = self.tree.tree[leaf_idx + self.tree.capacity - 1]

        # Importance sampling weights: w_i = (N * P(i))^(-beta) / max(w)
        probabilities = priorities / self.tree.total
        weights = (len(self) * probabilities) ** (-beta)
        weights /= weights.max()

        transitions = [self.data[idx] for idx in indices]
        # All sampled transitions should be non-None since we sample from filled slots
        return transitions, weights.astype(np.float32), indices  # type: ignore[return-value]

    def update_priorities(self, indices: list[int], td_errors: np.ndarray) -> None:
        """Update priorities based on TD error magnitudes."""
        for idx, td_error in zip(indices, td_errors):
            priority = (abs(td_error) + self.epsilon) ** self.alpha
            self.tree.update(idx, priority)
            self.max_priority = max(self.max_priority, abs(td_error) + self.epsilon)

    def trim(self, keep: int) -> None:
        """Rebuild the tree keeping only the most recent `keep` transitions.

        Since SumTree uses a circular buffer, "most recent" = the `keep`
        entries written just before the current write_idx.
        """
        if keep >= len(self):
            return
        capacity = self.tree.capacity
        old_data = self.data
        old_size = self.tree.size
        old_write = self.tree.write_idx

        # Collect recent entries in insertion order
        recent: list[tuple] = []
        idx = (old_write - 1) % capacity
        for _ in range(min(keep, old_size)):
            entry = old_data[idx]
            if entry is not None:
                recent.append(entry)
            idx = (idx - 1) % capacity
        recent.reverse()

        # Rebuild
        self.tree = SumTree(capacity)
        self.data = [None] * capacity
        self.max_priority = 1.0
        for t in recent:
            self.append(t)

    def __len__(self) -> int:
        return self.tree.size
