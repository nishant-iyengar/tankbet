# tensor-refresh

Kill and restart TensorBoard to pick up fresh data. Run this when the TensorBoard UI shows stale or overlapping runs.

## Steps

1. Kill any existing TensorBoard process
2. Restart TensorBoard pointing at the current TB logs directory
3. TensorBoard will be available at http://localhost:6006

## Command

```bash
ps aux | grep tensorboard | grep -v grep | awk '{print $2}' | xargs kill 2>/dev/null
sleep 1
cd /Users/nishant/Documents/software/tankbet/training
uv run tensorboard --logdir=runs/v1/tb_logs --port=6006 --reload_interval=5 2>&1 &
echo "TensorBoard restarted at http://localhost:6006"
```

## Notes

- IMPORTANT: Do NOT use the `--tensorboard` flag on `main.py` when TensorBoard is managed separately, otherwise killing TensorBoard kills training too.
- After restarting, hard-refresh the browser with Cmd+Shift+R
- If old runs are polluting the view, delete stale event files first:
  ```bash
  cd runs/v1/tb_logs && ls -t | tail -n +2 | xargs rm -f
  ```
