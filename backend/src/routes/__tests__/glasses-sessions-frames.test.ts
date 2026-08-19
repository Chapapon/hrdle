import type { ServerWebSocket } from 'bun';
import { describe, expect, test } from 'bun:test';
import { broadcastSessions, sendInitialSessions, sendSessionsTo, type MuxData } from '../terminal-mux';
import type { ExtendedSessionResponse } from '../../../../shared/types';

/**
 * A glasses connection receives the merged list, **always**.
 *
 * The app treats each frame as the whole list and drops any id the frame does
 * not mention. One plain frame therefore deletes every peer session, and the
 * next merged frame re-adds them at the end — the group order breaks (on
 * device: renders of 17 → 4 → 17 sessions).
 *
 * The plain frame got in through the freshly opened connection: the glasses
 * send `subscribe-glasses-relay` immediately, but it lands **while the first
 * list is being assembled**, and an audience decided before that assembly
 * sends a plain frame to a connection that has meanwhile named itself. A test
 * of the send function alone cannot reproduce that, so these tests race the
 * announcement against the assembly itself.
 */

function session(id: string): ExtendedSessionResponse {
  return {
    id,
    name: id,
    createdAt: '2026-08-13T00:00:00.000Z',
    lastAccessedAt: '2026-08-13T00:00:00.000Z',
    state: 'idle',
  };
}

const LOCAL = [session('w1'), session('w2')];
const PEER = session('peer:p_a1b2:w9');

/** The merge, shaped like the production sessionsWithPeers: adds the peers' sessions. */
const merge = async (local: ExtendedSessionResponse[]) => [...local, PEER];

interface FakeSocket {
  ws: ServerWebSocket<MuxData>;
  frames: Array<{ type: string; sessions?: ExtendedSessionResponse[] }>;
}

function socket(over: Partial<MuxData> = {}): FakeSocket {
  const frames: FakeSocket['frames'] = [];
  const ws = {
    data: {
      subscriptions: new Map(),
      conversationWatchers: new Map(),
      lastPingAt: 0,
      // Default: past the settle window without a word = a browser, as before.
      openedAt: 0,
      ...over,
    } as MuxData,
    send: (raw: string) => { frames.push(JSON.parse(raw)); },
  } as unknown as ServerWebSocket<MuxData>;
  return { ws, frames };
}

const hasPeer = (f: { sessions?: ExtendedSessionResponse[] }) =>
  (f.sessions ?? []).some((s) => s.id === PEER.id);

describe('the list sent to a glasses connection', () => {
  test('an announcement landing mid-assembly still gets the merged list', async () => {
    const { ws, frames } = socket({ isGlasses: false });

    // The device's real order: subscribe-glasses-relay arrives while the
    // first list is being assembled.
    await sendInitialSessions(
      ws,
      async () => {
        ws.data.isGlasses = true;
        return LOCAL;
      },
      merge,
    );

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(true);
  });

  test('assembly finishing before the announcement still merges (audience is read at send time)', async () => {
    const { ws, frames } = socket({ isGlasses: true });

    await sendInitialSessions(ws, async () => LOCAL, merge);

    expect(hasPeer(frames[0])).toBe(true);
  });

  test('a failed merge sends nothing (a plain frame would delete the peers)', async () => {
    const { ws, frames } = socket({ isGlasses: true });

    await sendSessionsTo(ws, LOCAL, async () => { throw new Error('peer unreachable'); });

    expect(frames).toHaveLength(0);
  });

  test('a failed assembly sends nothing either', async () => {
    const { ws, frames } = socket({ isGlasses: true });

    await sendInitialSessions(ws, async () => { throw new Error('herdr down'); }, merge);

    expect(frames).toHaveLength(0);
  });
});

describe('the list sent to a browser connection', () => {
  test('the plain list (a browser watches every peer itself)', async () => {
    const { ws, frames } = socket({ isGlasses: false });

    await sendInitialSessions(ws, async () => LOCAL, merge);

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(false);
    expect(frames[0].sessions?.map((s) => s.id)).toEqual(['w1', 'w2']);
  });

  test('the merge is not called (no fanout nobody reads)', async () => {
    const { ws } = socket({ isGlasses: false });
    let merged = 0;

    await sendInitialSessions(ws, async () => LOCAL, async (l) => { merged++; return l; });

    expect(merged).toBe(0);
  });
});

describe('no plain frame to a connection that has not spoken yet', () => {
  test('a broadcast skips a connection that has only just opened', () => {
    // The glasses reopen their socket on resume, and the announcement lands
    // **after** the open. A herdr-event broadcast running inside that gap was
    // the hole.
    const { ws, frames } = socket({ openedAt: Date.now() });

    broadcastSessions(LOCAL, [...LOCAL, PEER], undefined, [ws]);

    expect(frames).toHaveLength(0);
  });

  test('after the announcement the merged list arrives (nothing is lost)', async () => {
    const { ws, frames } = socket({ openedAt: Date.now() });

    broadcastSessions(LOCAL, [...LOCAL, PEER], undefined, [ws]);
    // Announce, and the existing catch-up delivers the merged list
    ws.data.isGlasses = true;
    await sendInitialSessions(ws, async () => LOCAL, merge);

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(true);
  });

  test('a connection that never speaks gets the plain list after the window, as before', () => {
    const { ws, frames } = socket({ openedAt: Date.now() - 60_000 });

    broadcastSessions(LOCAL, [...LOCAL, PEER], undefined, [ws]);

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(false);
  });

  test('a connection whose first word is not the announcement does not wait', () => {
    const { ws, frames } = socket({ openedAt: Date.now(), declaredBrowser: true });

    broadcastSessions(LOCAL, [...LOCAL, PEER], undefined, [ws]);

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(false);
  });

  test('an announced glasses connection gets the merged list', () => {
    const { ws, frames } = socket({ openedAt: Date.now(), isGlasses: true });

    broadcastSessions(LOCAL, [...LOCAL, PEER], undefined, [ws]);

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(true);
  });

  test('the initial frame also waits for the audience to settle', async () => {
    // The announcement lands after the assembly this time, not during it.
    const { ws, frames } = socket({ openedAt: Date.now() });
    const sent = sendInitialSessions(ws, async () => LOCAL, merge);
    await new Promise((r) => setTimeout(r, 60));
    expect(frames).toHaveLength(0); // still waiting

    ws.data.isGlasses = true;
    await sent;

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(true);
  });
});
