import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePiSmartMessage, isAllowedTranscriptPath } from '../notify';

const piDir = join(homedir(), '.pi');
const piFile = join(piDir, '.hrdle-test-transcript.jsonl');

describe('a pi transcript reaches the notification', () => {
  beforeAll(async () => {
    await mkdir(piDir, { recursive: true });
    await writeFile(piFile, '');
  });
  afterAll(async () => {
    await rm(piFile, { force: true });
  });

  test('its directory is one the route may read', async () => {
    expect(await isAllowedTranscriptPath(piFile)).toBe(true);
  });

  test('the message names what the turn did and quotes how it ended', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Running them now.' }, { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'bun test' } }], stopReason: 'toolUse' } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: '12 pass' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '```\nnoise\n```\nAll 12 tests pass.' }], stopReason: 'stop' } },
    ];
    expect(generatePiSmartMessage(entries)).toBe('Ran a command: All 12 tests pass.');
  });

  test('a turn with no tool and no text is simply done', () => {
    expect(generatePiSmartMessage([{ type: 'message', message: { role: 'assistant', content: [] } }])).toBe('Done');
  });
});
