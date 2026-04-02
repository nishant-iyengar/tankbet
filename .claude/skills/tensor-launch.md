# tensor-launch

Launch TensorBoard as a standalone background process. Use this when starting a new monitoring session.

## Command

```bash
cd /Users/nishant/Documents/software/tankbet/training
ps aux | grep tensorboard | grep -v grep | awk '{print $2}' | xargs kill 2>/dev/null
sleep 1
uv run tensorboard --logdir=runs/v1/tb_logs --port=6006 --reload_interval=5 2>&1 &
echo "TensorBoard launched at http://localhost:6006"
```

## Notes

- Runs in background — won't block training
- Auto-refreshes data every 5 seconds
- Open http://localhost:6006 in browser
- To clean stale data before launch:
  ```bash
  cd runs/v1/tb_logs && ls -t | tail -n +2 | xargs rm -f
  ```
