import { describe, expect, test } from 'bun:test';
import { AGENT_PROVIDERS, AGENT_PROVIDER_IDS, detectAgentProviderFromArgs } from '../../../../shared/types';

// The registry is what turns a pane's process into an agent, and herdr's own
// label for the pane must be a key in it or the pane is not an agent at all.
// Every id below is one herdr reports (`agent.list`'s `agent` field).
describe('agent provider registry', () => {
  test('the ids are the labels herdr reports', () => {
    expect([...AGENT_PROVIDER_IDS].sort()).toEqual(['claude', 'codex', 'grok', 'kimi', 'opencode', 'pi']);
    for (const id of AGENT_PROVIDER_IDS) expect(AGENT_PROVIDERS[id].id).toBe(id);
  });

  test('pi is found by its command and not by the words it is inside', () => {
    expect(detectAgentProviderFromArgs('/opt/homebrew/bin/pi')).toBe('pi');
    expect(detectAgentProviderFromArgs('pi --session 01a07188')).toBe('pi');
    expect(detectAgentProviderFromArgs('pip install foo')).toBeUndefined();
    expect(detectAgentProviderFromArgs('/usr/bin/pipewire')).toBeUndefined();
    expect(detectAgentProviderFromArgs('python -m pytest')).toBeUndefined();
  });

  test('a resume must not create a session that is missing', () => {
    expect(AGENT_PROVIDERS.pi.resumeCommand).toBe('pi --session');
  });
});
