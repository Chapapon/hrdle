import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDENTITY } from '../../../../shared/identity';
import { LOCAL_PEER_ID, type ExtendedSessionResponse } from '../../../../shared/types';

/**
 * The glasses' route to a peer's sessions.
 *
 * The glasses app hands ids back untouched, so "carry the peer on the id,
 * strip it on return and forward" being intact is the whole of this feature.
 *
 * The peer registry is a file in the data dir, so the temp dir must be
 * claimed before the import.
 */
process.env[IDENTITY.dataDirEnv] = mkdtempSync(join(tmpdir(), 'peer-sessions-'));

const {
  makePeerSessionId,
  parsePeerSessionId,
  namespacePeerSession,
  listPeerSessions,
  sessionsWithPeers,
  sortByPeerOrder,
  resetPeerSessionsCache,
} = await import('../peer-sessions');
const { createPeer, deletePeer, listPeers, setPeerOrder } = await import('../peer-registry');

function session(over: Partial<ExtendedSessionResponse> = {}): ExtendedSessionResponse {
  return {
    id: 'w1',
    name: 'hrdle',
    createdAt: '2026-08-13T00:00:00.000Z',
    lastAccessedAt: '2026-08-13T00:00:00.000Z',
    state: 'idle',
    ...over,
  };
}

describe('id round-trip', () => {
  test('the peer and the original id come back unchanged', () => {
    const ref = parsePeerSessionId(makePeerSessionId('p_a1b2', 'w1'));
    expect(ref).toEqual({ peerId: 'p_a1b2', localId: 'w1' });
  });

  test('a colon inside the original id does not move the split', () => {
    const ref = parsePeerSessionId(makePeerSessionId('p_a1b2', 'w1:t2:%3'));
    expect(ref).toEqual({ peerId: 'p_a1b2', localId: 'w1:t2:%3' });
  });

  test('this machine\'s own ids are not peers', () => {
    expect(parsePeerSessionId('w1')).toBeNull();
    expect(parsePeerSessionId('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
  });

  test('malformed shapes are not accepted as peers', () => {
    expect(parsePeerSessionId('peer:')).toBeNull();
    expect(parsePeerSessionId('peer:p_a1b2')).toBeNull();
    expect(parsePeerSessionId('peer:p_a1b2:')).toBeNull();
    expect(parsePeerSessionId('peer::w1')).toBeNull();
  });

  test('a path-climbing local id is rejected', () => {
    // encodeURIComponent passes a bare `..` through, and fetch resolves it.
    expect(parsePeerSessionId('peer:p_a1b2:..')).toBeNull();
    expect(parsePeerSessionId('peer:p_a1b2:.')).toBeNull();
  });
});

describe('namespacing a peer session', () => {
  const peer = { id: 'p_a1b2', nickname: 'LAPTOP', color: '#f00' };

  test('every id the glasses hand back is rewritten', () => {
    const out = namespacePeerSession(
      session({
        ccSessionId: 'cc-uuid',
        agentSessionId: 'agent-uuid',
        panes: [
          { paneId: '%1', isActive: true, agentSessionId: 'pane-uuid' },
          { paneId: '%2', isActive: false },
        ],
      }),
      peer,
    );

    expect(out.id).toBe('peer:p_a1b2:w1');
    expect(out.ccSessionId).toBe('peer:p_a1b2:cc-uuid');
    expect(out.agentSessionId).toBe('peer:p_a1b2:agent-uuid');
    expect(out.panes?.[0].agentSessionId).toBe('peer:p_a1b2:pane-uuid');
    // A pane with no conversation id stays without one (no empty-string ids).
    expect(out.panes?.[1].agentSessionId).toBeUndefined();
  });

  test('paneId is left alone (the peer expects its own value back)', () => {
    const out = namespacePeerSession(
      session({ panes: [{ paneId: '%1', isActive: true }] }),
      peer,
    );
    expect(out.panes?.[0].paneId).toBe('%1');
  });

  test('the name says which machine it is on', () => {
    expect(namespacePeerSession(session(), peer).name).toBe('LAPTOP/hrdle');
  });

  test('a customTitle takes the prefix instead (the glasses prefer it)', () => {
    const out = namespacePeerSession(session({ customTitle: 'old title' }), peer);
    expect(out.customTitle).toBe('LAPTOP/old title');
    expect(out.name).toBe('hrdle');
  });

  test('the owning peer is also carried structurally', () => {
    const out = namespacePeerSession(session(), peer);
    expect(out.peerId).toBe('p_a1b2');
    expect(out.peerNickname).toBe('LAPTOP');
  });
});

describe('the order\'s source of truth (the peers settings)', () => {
  test('ascending by order', () => {
    const sorted = sortByPeerOrder([{ order: 2, id: 'b' }, { order: 0, id: 'a' }, { order: 1, id: 'c' }]);
    expect(sorted.map(x => x.id)).toEqual(['a', 'c', 'b']);
  });

  test('a peer saved before order existed falls to the end', () => {
    const sorted = sortByPeerOrder([{ id: 'no-order' }, { order: 5, id: 'has-order' }]);
    expect(sorted.map(x => x.id)).toEqual(['has-order', 'no-order']);
  });

  test('a non-numeric order falls to the end too (corrupt data must not sit on top)', () => {
    const sorted = sortByPeerOrder([
      { order: Number.NaN, id: 'broken' },
      { order: 3, id: 'ok' },
    ]);
    expect(sorted.map(x => x.id)).toEqual(['ok', 'broken']);
  });

  test('ties keep their given order', () => {
    const sorted = sortByPeerOrder([{ order: 1, id: 'first' }, { order: 1, id: 'second' }]);
    expect(sorted.map(x => x.id)).toEqual(['first', 'second']);
  });
});

describe('merging the list', () => {
  const realFetch = globalThis.fetch;
  const created: string[] = [];

  function stubFetch(handler: (url: string) => Response): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      return handler(url);
    }) as typeof fetch;
    return seen;
  }

  const sessionsBody = (...ids: string[]) =>
    Response.json({ sessions: ids.map(id => session({ id, name: id })) });

  beforeEach(() => {
    resetPeerSessionsCache();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    for (const id of created.splice(0)) await deletePeer(id);
    // The reorder persists; put the default (local first) back so it does not
    // leak into the next test.
    await setPeerOrder([LOCAL_PEER_ID]);
    resetPeerSessionsCache();
  });

  async function addPeer(nickname: string, host: string) {
    const peer = await createPeer({
      nickname,
      url: `https://${host}.example.ts.net`,
      wsToken: 'token',
    });
    created.push(peer.id);
    return peer;
  }

  test('a peer is asked for its own sessions only (no peers-of-peers)', async () => {
    await addPeer('LAPTOP', 'mac');
    const seen = stubFetch(() => sessionsBody('w1'));

    await listPeerSessions();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/api/sessions?local=1');
  });

  test('returned sessions come back namespaced', async () => {
    const peer = await addPeer('LAPTOP', 'mac');
    stubFetch(() => sessionsBody('w1'));

    const merged = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(merged.map(s => s.id)).toEqual(['local-1', `peer:${peer.id}:w1`]);
    expect(merged[1].peerNickname).toBe('LAPTOP');
  });

  test('an unreachable peer does not empty the list of the ones that answered', async () => {
    await addPeer('LAPTOP', 'mac');
    const second = await addPeer('SECOND', 'second');
    stubFetch((url) => {
      if (url.includes('mac')) throw new Error('connect ECONNREFUSED');
      return sessionsBody('w9');
    });

    const merged = await sessionsWithPeers([]);

    expect(merged.map(s => s.id)).toEqual([`peer:${second.id}:w9`]);
  });

  test('sessions a peer does not own are dropped', async () => {
    const peer = await addPeer('LAPTOP', 'mac');
    stubFetch(() => Response.json({
      sessions: [session({ id: 'w1' }), session({ id: 'peer:p_other:w2' })],
    }));

    const merged = await sessionsWithPeers([]);

    expect(merged.map(s => s.id)).toEqual([`peer:${peer.id}:w1`]);
  });

  test('back-to-back calls share one fanout (the 5s push must not hammer peers)', async () => {
    await addPeer('LAPTOP', 'mac');
    const seen = stubFetch(() => sessionsBody('w1'));

    await Promise.all([listPeerSessions(), listPeerSessions()]);
    await listPeerSessions();

    expect(seen).toHaveLength(1);
  });

  test('the peers settings decide the order — local is not necessarily first', async () => {
    const mac = await addPeer('LAPTOP', 'mac');
    stubFetch(() => sessionsBody('w1'));

    // "the laptop on top" = a reorder in the peers settings, local below it.
    await setPeerOrder([mac.id, LOCAL_PEER_ID]);
    resetPeerSessionsCache();

    const merged = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(merged.map(s => s.id)).toEqual([`peer:${mac.id}:w1`, 'local-1']);
  });

  test('the local machine\'s own position is honoured', async () => {
    // listPeers synthesises an order-0 local row when none is stored, so unless
    // the reorder materialises it, the choice is silently dropped.
    const mac = await addPeer('LAPTOP', 'mac');

    await setPeerOrder([mac.id, LOCAL_PEER_ID]);

    expect((await listPeers()).find(p => p.id === LOCAL_PEER_ID)?.order).toBe(1);
  });

  test('reordering the peers reorders the merge (one source of truth)', async () => {
    const mac = await addPeer('LAPTOP', 'mac');
    stubFetch(() => sessionsBody('w1'));

    await setPeerOrder([LOCAL_PEER_ID, mac.id]);
    resetPeerSessionsCache();
    const localFirst = await sessionsWithPeers([session({ id: 'local-1' })]);

    await setPeerOrder([mac.id, LOCAL_PEER_ID]);
    resetPeerSessionsCache();
    const macFirst = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(localFirst.map(s => s.id)).toEqual(['local-1', `peer:${mac.id}:w1`]);
    expect(macFirst.map(s => s.id)).toEqual([`peer:${mac.id}:w1`, 'local-1']);
  });

  test('with no peers registered the given array is returned unchanged', async () => {
    expect((await listPeers()).every(p => p.url === 'self')).toBe(true);
    const local = [session({ id: 'local-1' })];

    expect(await sessionsWithPeers(local)).toBe(local);
  });
});
