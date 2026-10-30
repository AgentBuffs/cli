/**
 * The guards around a full-screen run. Whatever ends it (the last step, a
 * cancel, an error, Ctrl+C outside a prompt, SIGTERM) leaves the alternate
 * screen and shows the cursor again: `main` leaves on its own paths, a signal
 * calls `interrupt`, the `finally` covers a thrown error, and the `exit`
 * listener covers anything that ends the process early.
 */
import type { FullscreenScreen, StopSignal } from './fullscreen.ts';

/** The part of `process` the guards use, so tests can send signals. */
export type ProcessEvents = {
  on(event: StopSignal | 'exit', listener: () => void): void;
  off(event: StopSignal | 'exit', listener: () => void): void;
};

const SIGNALS: readonly StopSignal[] = ['SIGINT', 'SIGTERM'];

/** Runs `run`. With a full screen, guards the terminal until it returns or throws. */
export async function runGuarded(opts: {
  fullscreen: FullscreenScreen | null;
  run: () => Promise<number>;
  events: ProcessEvents;
  exit: (code: number) => void;
}): Promise<number> {
  const { fullscreen, events } = opts;
  if (fullscreen === null) return opts.run();
  const onSignal = new Map(SIGNALS.map((signal) => [signal, () => opts.exit(fullscreen.interrupt(signal))]));
  const onExit = (): void => fullscreen.restore();
  for (const [signal, listener] of onSignal) events.on(signal, listener);
  events.on('exit', onExit);
  try {
    return await opts.run();
  } finally {
    await fullscreen.leave();
    for (const [signal, listener] of onSignal) events.off(signal, listener);
    events.off('exit', onExit);
  }
}
