import { useEffect, useRef } from 'react';
import { CELL_SIZE, MAZE_COLS, MAZE_ROWS } from '@tankbet/game-engine/constants';
import { PracticeEngine } from '../practice/PracticeEngine';

export function PracticePage(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PracticeEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = MAZE_COLS * CELL_SIZE;
    canvas.height = MAZE_ROWS * CELL_SIZE;

    const engine = new PracticeEngine(canvas);
    engineRef.current = engine;
    engine.start();

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-white">Practice Mode</h1>
        <button
          onClick={() => engineRef.current?.regenerateMaze()}
          className="border border-slate-600 text-slate-300 text-sm font-medium px-4 py-2 rounded-lg hover:border-slate-500 hover:text-white transition-colors"
        >
          New Maze
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="border border-slate-700/50 rounded-lg"
        style={{ display: 'block' }}
      />
    </div>
  );
}
