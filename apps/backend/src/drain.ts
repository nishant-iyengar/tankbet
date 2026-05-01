/**
 * Drain state — shared across the server and all route handlers.
 *
 * When isDraining is true the server has received SIGTERM and is winding down:
 *  - /health returns 503 so Fly stops routing new traffic here
 *  - Room-creating routes (accept game, start practice) return 503
 *  - Active games continue until they finish or the kill_timeout elapses
 */
let draining = false;

export function isDraining(): boolean {
  return draining;
}

export function setDraining(): void {
  draining = true;
}
