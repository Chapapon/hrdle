import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiSessionStore } from '../pi';
import { lastAssistantTurn, PiTurnWatcher, type PiTurnEnd } from '../pi-turn-watcher';

const ID = '01a0726e-d7d9-7217-b3f8-11a4c3fdb0cb';

function record(id: string, role: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: 'message', id, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text: 'x' }], ...extra } })}\n`;
}

function session(): { store: PiSessionStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-watch-'));
  const dir = join(root, '--tmp-x--');
  mkdirSync(dir);
  const path = join(dir, `2026-09-05T16-37-41-978Z_${ID}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: 'session', version: 3, id: ID, timestamp: 't', cwd: '/tmp/x' })}\n${record('u0', 'user')}${record('a0', 'assistant', { stopReason: 'stop' })}`);
  return { store: new PiSessionStore(root), path };
}

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

describe('a finished pi turn, read off the file', () => {
  test('the record that ends a turn is the last assistant one, with its reason', () => {
    expect(lastAssistantTurn([record('u1', 'user'), record('a1', 'assistant', { stopReason: 'toolUse' }), record('t1', 'toolResult')])).toEqual({ id: 'a1', stopReason: 'toolUse' });
    expect(lastAssistantTurn([record('u1', 'user')])).toBeUndefined();
  });

  test('history is not news; a stop is; a tool call is not; an error is', async () => {
    const { store, path } = session();
    const seen: PiTurnEnd[] = [];
    const watcher = new PiTurnWatcher((t) => seen.push(t), store);
    try {
      await watcher.track([{ sessionId: ID, cwd: '/tmp/x' }]);
      await settle();
      expect(seen).toEqual([]);
      appendFileSync(path, record('u1', 'user') + record('a1', 'assistant', { stopReason: 'toolUse' }));
      await settle();
      expect(seen).toEqual([]);
      appendFileSync(path, record('t1', 'toolResult') + record('a2', 'assistant', { stopReason: 'stop' }));
      await settle();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ sessionId: ID, cwd: '/tmp/x', transcriptPath: path, stopReason: 'stop' });
      appendFileSync(path, record('u2', 'user') + record('a3', 'assistant', { stopReason: 'error' }));
      await settle();
      expect(seen).toHaveLength(2);
      // The same file changing without a new assistant record is nothing.
      appendFileSync(path, record('u3', 'user'));
      await settle();
      expect(seen).toHaveLength(2);
    } finally {
      watcher.close();
    }
  });

  test('a session that left the list is no longer watched', async () => {
    const { store, path } = session();
    const seen: PiTurnEnd[] = [];
    const watcher = new PiTurnWatcher((t) => seen.push(t), store);
    try {
      await watcher.track([{ sessionId: ID }]);
      await watcher.track([]);
      appendFileSync(path, record('u1', 'user') + record('a1', 'assistant', { stopReason: 'stop' }));
      await settle();
      expect(seen).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  test('an unknown session is skipped, not thrown', async () => {
    const watcher = new PiTurnWatcher(() => {}, new PiSessionStore(mkdtempSync(join(tmpdir(), 'pi-empty-'))));
    await expect(watcher.track([{ sessionId: 'nope' }])).resolves.toBeUndefined();
    watcher.close();
  });
});
