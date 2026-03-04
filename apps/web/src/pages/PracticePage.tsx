import { useEffect, useRef, useState, useCallback } from 'react';
import { Client } from '@colyseus/sdk';
import { GameEngine } from '../game/GameEngine';
import type { SeatReservation } from '../game/GameEngine';
import { apiFetch } from '../api/client';
import { CELL_SIZE, MAZE_COLS, MAZE_ROWS } from '@tankbet/game-engine/constants';

interface PracticeStartResponse {
  reservation: SeatReservation;
  userId: string;
}

interface ToxicAttributes {
  latency: number;
  jitter: number;
}

const IS_DEV = import.meta.env.DEV;

function NetworkSimPanel({
  onWsUrlChange,
  onSimStateChange,
}: {
  onWsUrlChange: (url: string) => void;
  onSimStateChange: (active: boolean, latency: number, jitter: number) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [latency, setLatency] = useState(0);
  const [jitter, setJitter] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);

  // Check if toxiproxy is running
  useEffect(() => {
    let cancelled = false;
    fetch('/toxiproxy/version')
      .then((res) => {
        if (!cancelled) setAvailable(res.ok);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateToxic = useCallback(async (attrs: ToxicAttributes) => {
    setUpdating(true);
    try {
      await fetch('/toxiproxy/proxies/tankbet/toxics/latency_downstream', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes: attrs }),
      });
    } catch {
      // toxiproxy may be unavailable — ignore
    } finally {
      setUpdating(false);
    }
  }, []);

  const handleToggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    if (next) {
      onWsUrlChange('ws://localhost:3002');
      void updateToxic({ latency, jitter });
      onSimStateChange(true, latency, jitter);
    } else {
      const defaultUrl = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';
      onWsUrlChange(defaultUrl);
      onSimStateChange(false, 0, 0);
    }
  }, [enabled, latency, jitter, onWsUrlChange, updateToxic, onSimStateChange]);

  const handleLatencyChange = useCallback(
    (value: number) => {
      setLatency(value);
      if (enabled) {
        void updateToxic({ latency: value, jitter });
        onSimStateChange(true, value, jitter);
      }
    },
    [enabled, jitter, updateToxic, onSimStateChange],
  );

  const handleJitterChange = useCallback(
    (value: number) => {
      setJitter(value);
      if (enabled) {
        void updateToxic({ latency, jitter: value });
        onSimStateChange(true, latency, value);
      }
    },
    [enabled, latency, updateToxic, onSimStateChange],
  );

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="border border-slate-600 text-slate-300 text-sm font-medium px-4 py-2 rounded-lg hover:border-slate-500 hover:text-white transition-colors"
      >
        Network Sim
      </button>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-4 w-64 text-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-slate-100 font-medium">Network Simulation</span>
        <button
          onClick={() => setOpen(false)}
          className="text-slate-500 hover:text-slate-300 text-xs"
        >
          Close
        </button>
      </div>

      {available === false && (
        <p className="text-slate-500 text-xs mb-3">
          Toxiproxy not running. Install:{' '}
          <code className="text-slate-400">brew install toxiproxy</code>
        </p>
      )}

      <label className="flex items-center gap-2 mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={handleToggle}
          disabled={available === false}
          className="accent-cyan-400"
        />
        <span className={enabled ? 'text-cyan-400' : 'text-slate-400'}>
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
        {updating && <span className="text-slate-500 text-xs">updating…</span>}
      </label>

      <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
        <div className="mb-3">
          <div className="flex justify-between text-slate-400 mb-1">
            <span>Latency</span>
            <span className="tabular-nums">{latency}ms</span>
          </div>
          <input
            type="range"
            min={0}
            max={500}
            step={10}
            value={latency}
            onChange={(e) => handleLatencyChange(Number(e.target.value))}
            className="w-full accent-cyan-400"
          />
        </div>

        <div>
          <div className="flex justify-between text-slate-400 mb-1">
            <span>Jitter</span>
            <span className="tabular-nums">{jitter}ms</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={jitter}
            onChange={(e) => handleJitterChange(Number(e.target.value))}
            className="w-full accent-cyan-400"
          />
        </div>
      </div>
    </div>
  );
}

export function PracticePage(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const wsUrlRef = useRef(import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001');
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');
  const [error, setError] = useState('');
  // Incrementing this key tears down + restarts the engine (New Maze)
  const [sessionKey, setSessionKey] = useState(0);
  const [simState, setSimState] = useState<{ active: boolean; latency: number; jitter: number }>({
    active: false,
    latency: 0,
    jitter: 0,
  });

  useEffect(() => {
    let cancelled = false;

    async function start(): Promise<void> {
      if (!canvasRef.current) return;

      setStatus('loading');
      setError('');

      try {
        const { reservation, userId } = await apiFetch<PracticeStartResponse>('/api/practice/start', {
          method: 'POST',
        });

        if (cancelled || !canvasRef.current) return;

        const client = new Client(wsUrlRef.current);
        const engine = new GameEngine(canvasRef.current);
        engineRef.current = engine;

        engine.setPhaseChangeCallback((phase) => {
          if (phase === 'playing') setStatus('playing');
        });

        await engine.connect(client, reservation, 0, userId, '', 0, true);
        if (!cancelled) setStatus('playing');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to connect');
          setStatus('error');
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [sessionKey]);

  function newMaze(): void {
    engineRef.current?.destroy();
    engineRef.current = null;
    setSessionKey((k) => k + 1);
  }

  const handleWsUrlChange = useCallback((url: string) => {
    wsUrlRef.current = url;
    // Reconnect with new URL
    engineRef.current?.destroy();
    engineRef.current = null;
    setSessionKey((k) => k + 1);
  }, []);

  const handleSimStateChange = useCallback((active: boolean, latency: number, jitter: number) => {
    setSimState({ active, latency, jitter });
  }, []);

  return (
    <div className="flex items-start gap-3">
      <div className="relative inline-block">
        <canvas
          ref={canvasRef}
          width={MAZE_COLS * CELL_SIZE}
          height={MAZE_ROWS * CELL_SIZE}
          className="border border-slate-700/50 rounded-lg block"
        />
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
            <p className="text-slate-400 text-sm">Connecting…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
            <div className="text-center">
              <p className="text-red-400 text-sm mb-3">{error}</p>
              <button
                onClick={newMaze}
                className="text-cyan-400 hover:text-cyan-300 text-sm underline"
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {simState.active && (
          <div className="absolute top-2 left-2 bg-black/70 text-yellow-400 text-xs font-mono px-2 py-1 rounded tabular-nums pointer-events-none">
            {simState.latency}ms +{simState.jitter}ms jitter
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={newMaze}
          className="border border-slate-600 text-slate-300 text-sm font-medium px-4 py-2 rounded-lg hover:border-slate-500 hover:text-white transition-colors"
        >
          New Maze
        </button>
        {IS_DEV && (
          <NetworkSimPanel
            onWsUrlChange={handleWsUrlChange}
            onSimStateChange={handleSimStateChange}
          />
        )}
      </div>
    </div>
  );
}
