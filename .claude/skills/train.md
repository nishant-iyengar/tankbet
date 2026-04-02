# train

Resume PPO training from the latest checkpoint with auto-promotion enabled.

## Command

```bash
cd /Users/nishant/Documents/software/tankbet/training && uv run python main.py --algo ppo --env tank --phase 0 --auto-promote --resume
```

## Notes

- Uses `--resume` to pick up from the latest checkpoint
- `--phase 0` with `--auto-promote` means it starts at whatever phase is saved and auto-promotes
- Does NOT include `--tensorboard` — launch TensorBoard separately with `/tensor-launch` to avoid process coupling (killing TB would kill training)
- To restart from a specific phase's best weights, create a fresh state checkpoint before running
- Monitor with `tail -f /tmp/ppo_training.log`
