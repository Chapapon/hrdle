import { watch, type FSWatcher } from 'node:fs';
import { open } from 'node:fs/promises';
import { parsePiRecord, PiSessionStore } from './pi';

/**
 * A finished pi turn, seen in the file rather than heard from a hook.
 *
 * Claude, Codex and the rest announce a finished turn through a hook that runs
 * `hrdle notify`. pi has extensions instead of hooks, and an extension has to
 * be installed - so a bare pi would be the one agent that finishes in silence.
 * pi does write every turn down as it happens, though: the assistant message
 * that ends a turn carries `stopReason: "stop"` (or `"error"`), where a turn
 * that is still going carries `"toolUse"`. Watching the session file for that
 * record is the same event, from a source that needs nothing installed.
 *
 * Only sessions that are live in a pane are watched, and only turns that end
 * after the watch began are reported: a session's history is not news.
 */
export interface PiLiveSession {
  sessionId: string;
  cwd?: string;
}

export interface PiTurnEnd {
  sessionId: string;
  cwd?: string;
  transcriptPath: string;
  stopReason: string;
}

const TURN_END_STOP_REASONS = new Set(['stop', 'error']);
const DEBOUNCE_MS = 300;

interface Watched {
  path: string;
  cwd?: string;
  watcher: FSWatcher;
  lastAssistantId?: string;
  timer?: ReturnType<typeof setTimeout>;
}

async function readTailLines(path: string, bytes = 65_536): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/** The last assistant record in the lines, and whether it ends a turn. */
export function lastAssistantTurn(lines: string[]): { id?: string; stopReason?: string } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parsePiRecord(lines[i]);
    if (record?.type !== 'message' || record.message?.role !== 'assistant') continue;
    const stopReason = (record.message as { stopReason?: unknown }).stopReason;
    return { id: record.id, stopReason: typeof stopReason === 'string' ? stopReason : undefined };
  }
  return undefined;
}

export class PiTurnWatcher {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly onTurnEnd: (turn: PiTurnEnd) => void,
    private readonly store = new PiSessionStore(),
  ) {}

  /** Bring the set of watched files in line with the sessions that are live. */
  async track(live: PiLiveSession[]): Promise<void> {
    const wanted = new Map(live.map((s) => [s.sessionId, s]));
    for (const [sessionId, entry] of this.watched) {
      if (!wanted.has(sessionId)) {
        this.stop(sessionId, entry);
      }
    }
    for (const [sessionId, session] of wanted) {
      if (this.watched.has(sessionId)) continue;
      const found = await this.store.findSession(sessionId).catch(() => undefined);
      if (!found) continue;
      await this.start(sessionId, found.path, session.cwd ?? found.cwd);
    }
  }

  private async start(sessionId: string, path: string, cwd?: string): Promise<void> {
    let lastAssistantId: string | undefined;
    try {
      lastAssistantId = lastAssistantTurn(await readTailLines(path))?.id;
    } catch {
      return;
    }
    let watcher: FSWatcher;
    try {
      watcher = watch(path, { persistent: false }, () => this.onChange(sessionId));
      watcher.on('error', () => this.stop(sessionId));
    } catch {
      return;
    }
    // A second start for the same session while the first was still reading:
    // keep the one already in the map.
    if (this.watched.has(sessionId)) {
      watcher.close();
      return;
    }
    this.watched.set(sessionId, { path, cwd, watcher, lastAssistantId });
  }

  private stop(sessionId: string, entry = this.watched.get(sessionId)): void {
    if (!entry) return;
    this.watched.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
  }

  private onChange(sessionId: string): void {
    const entry = this.watched.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.check(sessionId);
    }, DEBOUNCE_MS);
  }

  private async check(sessionId: string): Promise<void> {
    const entry = this.watched.get(sessionId);
    if (!entry) return;
    let turn: ReturnType<typeof lastAssistantTurn>;
    try {
      turn = lastAssistantTurn(await readTailLines(entry.path));
    } catch {
      return;
    }
    if (!turn?.id || turn.id === entry.lastAssistantId) return;
    entry.lastAssistantId = turn.id;
    if (!turn.stopReason || !TURN_END_STOP_REASONS.has(turn.stopReason)) return;
    try {
      this.onTurnEnd({ sessionId, cwd: entry.cwd, transcriptPath: entry.path, stopReason: turn.stopReason });
    } catch (error) {
      console.warn('[pi-watcher] turn-end handler failed:', error);
    }
  }

  /** For tests and shutdown. */
  close(): void {
    for (const [sessionId, entry] of this.watched) this.stop(sessionId, entry);
  }
}
