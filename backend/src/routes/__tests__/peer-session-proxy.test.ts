import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDENTITY } from '../../../../shared/identity';

/**
 * A request addressed to a peer's session reaches that machine.
 *
 * The glasses only ever put a received id back into a URL, so failing to
 * notice a peer id here — strip it, forward it — does not error: the reply
 * silently goes to THIS machine's herdr instead. A wrong branch talks to the
 * wrong machine rather than falling over, which is why the route itself is
 * pinned.
 *
 * The peer registry is a file in the data dir, so the temp dir must be
 * claimed before the import.
 */
process.env[IDENTITY.dataDirEnv] = mkdtempSync(join(tmpdir(), 'peer-proxy-'));

const { sessions } = await import('../sessions');
const { createPeer, deletePeer } = await import('../../services/peer-registry');
const { makePeerSessionId, resetPeerSessionsCache } = await import('../../services/peer-sessions');

const realFetch = globalThis.fetch;
const created: string[] = [];

interface SeenRequest {
  url: string;
  method: string;
  body: string;
}

function stubFetch(response: () => Response): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return response();
  }) as typeof fetch;
  return seen;
}

async function addPeer() {
  const peer = await createPeer({
    nickname: 'LAPTOP',
    url: 'https://mac.example.ts.net',
    wsToken: 'token',
  });
  created.push(peer.id);
  return peer;
}

beforeEach(() => {
  resetPeerSessionsCache();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const id of created.splice(0)) await deletePeer(id);
  resetPeerSessionsCache();
});

describe('forwarding to a peer-owned session', () => {
  test('a conversation is read from the machine that holds the transcript (with its own id)', async () => {
    const peer = await addPeer();
    const seen = stubFetch(() => Response.json({ messages: [{ role: 'assistant', content: 'hi' }] }));

    const id = makePeerSessionId(peer.id, 'cc-uuid');
    const res = await sessions.request(`/history/${encodeURIComponent(id)}/conversation?last=10`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [{ role: 'assistant', content: 'hi' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(
      'https://mac.example.ts.net/api/sessions/history/cc-uuid/conversation?last=10',
    );
  });

  test('a prompt is handed to the same endpoint on the owner (paneId untouched)', async () => {
    const peer = await addPeer();
    const seen = stubFetch(() => Response.json({ success: true, paneId: '%3' }));

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'w1'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello there', paneId: '%3' }),
      },
    );

    expect(res.status).toBe(200);
    expect(seen[0].url).toBe('https://mac.example.ts.net/api/sessions/w1/prompt');
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body)).toEqual({ text: 'hello there', paneId: '%3' });
  });

  test('raw key input (a choice answer) takes the same route', async () => {
    const peer = await addPeer();
    const seen = stubFetch(() => Response.json({ success: true }));

    await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'w1'))}/panes/input`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paneId: '%3', data: '\r' }),
      },
    );

    expect(seen[0].url).toBe('https://mac.example.ts.net/api/sessions/w1/panes/input');
    expect(JSON.parse(seen[0].body)).toEqual({ paneId: '%3', data: '\r' });
  });

  test('a failure the owner reported is passed through, not dressed as success', async () => {
    const peer = await addPeer();
    stubFetch(() => Response.json({ error: 'Session not found' }, { status: 404 }));

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'gone'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
    );

    expect(res.status).toBe(404);
  });

  test('an unreachable owner is a 502, never rerouted to a local session', async () => {
    const peer = await addPeer();
    stubFetch(() => { throw new Error('connect ECONNREFUSED'); });

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'w1'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
    );

    expect(res.status).toBe(502);
  });

  test('an unknown peer id is a 404 (a stale id after deregistration)', async () => {
    const seen = stubFetch(() => Response.json({ success: true }));

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId('p_deadbeef', 'w1'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
    );

    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
