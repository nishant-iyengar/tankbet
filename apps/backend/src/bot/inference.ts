/**
 * Minimal neural network forward pass for the PPO actor.
 *
 * Architecture: 2-layer separate actor (147→256→256 with Tanh) + linear head (256→18).
 * ~108K params, sub-1ms inference. Zero external dependencies.
 */
import weights from './tank-bot-weights.json' with { type: 'json' };

interface Layer {
  weight: number[][];
  bias: number[];
}

const layers = weights.layers as Layer[];
const isTanh = weights.architecture === 'separate_tanh';

/**
 * Forward pass through the actor network.
 * @param obs 147-dim observation vector
 * @returns action index (0-17) via argmax over logits
 */
export function forward(obs: Float32Array): number {
  let x: number[] = Array.from(obs);

  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l]!;
    const outSize = layer.bias.length;
    const out: number[] = new Array<number>(outSize);
    const w = layer.weight;
    const b = layer.bias;

    for (let i = 0; i < outSize; i++) {
      let sum = b[i]!;
      const row = w[i]!;
      for (let j = 0; j < x.length; j++) {
        sum += row[j]! * x[j]!;
      }
      out[i] = sum;
    }

    // Apply activation to all layers except the last (actor head outputs raw logits)
    if (l < layers.length - 1) {
      if (isTanh) {
        for (let i = 0; i < outSize; i++) {
          out[i] = Math.tanh(out[i]!);
        }
      } else {
        for (let i = 0; i < outSize; i++) {
          if (out[i]! < 0) out[i] = 0;
        }
      }
    }

    x = out;
  }

  // Argmax over logits
  let bestIdx = 0;
  let bestVal = x[0]!;
  for (let i = 1; i < x.length; i++) {
    if (x[i]! > bestVal) {
      bestVal = x[i]!;
      bestIdx = i;
    }
  }

  return bestIdx;
}
