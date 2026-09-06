import { notify } from '../routes/notify';
import { PiTurnWatcher } from './pi-turn-watcher';

/**
 * The one watcher the server runs, delivering a finished pi turn as the hook
 * event it would have been: the same `POST /api/notify` body a `Stop` hook
 * sends, handed to the route in-process. Everything downstream - the
 * indicator, the notification text, the glasses relay, the browser push -
 * then treats it exactly as it treats every other agent's, and nothing in
 * that path knows the difference.
 */
export const piTurnWatcher = new PiTurnWatcher((turn) => {
  void Promise.resolve(
    notify.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: turn.sessionId,
        cwd: turn.cwd,
        transcript_path: turn.transcriptPath,
        agent: 'pi',
        stop_reason: turn.stopReason,
      }),
    }),
  ).catch((error: unknown) => console.warn('[pi-watcher] notify failed:', error));
});
