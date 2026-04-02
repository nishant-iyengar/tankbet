"""Export PPO actor weights to JSON for server-side inference.

Supports both architectures:
  - separate=True: actor_net.{0,2,4}.{weight,bias} (2×hidden Tanh)
  - separate=False: shared.{0,2,4}.{weight,bias} + actor.{weight,bias} (3×hidden ReLU)

Output: apps/backend/src/bot/tank-bot-weights.json
Format: { "architecture": "separate_tanh"|"shared_relu", "layers": [...] }
"""

import json
import os
from pathlib import Path

import torch

MODEL_PATH = Path(__file__).parent / "ppo_model_latest.pt"
OUTPUT_PATH = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "backend"
    / "src"
    / "bot"
    / "tank-bot-weights.json"
)


def main() -> None:
    state_dict = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)

    separate = "actor_net.0.weight" in state_dict

    layers = []

    if separate:
        # Separate actor: actor_net.0, actor_net.2, actor_net.4
        print("Architecture: separate actor/critic (Tanh)")
        layer_keys = [
            ("actor_net.0.weight", "actor_net.0.bias"),
            ("actor_net.2.weight", "actor_net.2.bias"),
            ("actor_net.4.weight", "actor_net.4.bias"),
        ]
        architecture = "separate_tanh"
    else:
        # Shared trunk: shared.0, shared.2, shared.4 + actor head
        print("Architecture: shared trunk (ReLU)")
        layer_keys = [
            ("shared.0.weight", "shared.0.bias"),
            ("shared.2.weight", "shared.2.bias"),
            ("shared.4.weight", "shared.4.bias"),
            ("actor.weight", "actor.bias"),
        ]
        architecture = "shared_relu"

    for w_key, b_key in layer_keys:
        weight = state_dict[w_key].tolist()
        bias = state_dict[b_key].tolist()
        layers.append({"weight": weight, "bias": bias})
        print(f"  {w_key}: {len(weight)}x{len(weight[0])}")

    output = {"architecture": architecture, "layers": layers}

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f)

    file_size = os.path.getsize(OUTPUT_PATH)
    print(f"\nExported {len(layers)} layers to {OUTPUT_PATH}")
    print(f"File size: {file_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
