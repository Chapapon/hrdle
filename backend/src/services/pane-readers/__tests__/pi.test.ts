// Reading pi's select prompt. The fixture is a live 0.84.2 pane, captured on
// 2026-09-06 while a tool built on `ctx.ui.select` was asking.
import { describe, expect, test } from 'bun:test';
import { detectPaneState } from '../../pane-state';
import { readPiSelect } from '../pi';

const SELECT = [
  ' もう一回 ask_user を出して。選択肢は3つにして',
  ' ask_user',
  '──────────────────────────────────────────────────────────────',
  ' どのおすすめを知りたいですか？ (590s)',
  ' → 一蘭のおすすめメニュー',
  '   ラーメンの種類ごとのおすすめ',
  '   ラーメン店のおすすめ',
  ' ↑↓ navigate  enter select  escape/ctrl+c cancel',
  '──────────────────────────────────────────────────────────────',
  '~/tmp/pi-hrdle-test',
  '↑16k ↓628 R65k CH96.8% $0.259 (sub) 2.9%/272k (auto)        (openai-codex) gpt-6-astra',
];

describe("pi's select prompt", () => {
  test('is the question, every row, and where the cursor sits', () => {
    const q = readPiSelect(SELECT);
    expect(q?.question).toBe('どのおすすめを知りたいですか？ (590s)');
    expect(q?.options.map((o) => o.label)).toEqual(['一蘭のおすすめメニュー', 'ラーメンの種類ごとのおすすめ', 'ラーメン店のおすすめ']);
    expect(q).toMatchObject({ multiSelect: false, choiceInput: 'arrow', choiceAxis: 'column', choiceSelected: 0 });
  });

  test('the cursor can be on a later row', () => {
    const moved = SELECT.map((l) => l.replace(' → 一蘭', '   一蘭').replace('   ラーメン店', ' → ラーメン店'));
    expect(readPiSelect(moved)?.choiceSelected).toBe(2);
  });

  test('a pane with no prompt reads as nothing', () => {
    expect(readPiSelect(SELECT.slice(-3))).toBeUndefined();
    expect(readPiSelect(['❯ ', '~/x'])).toBeUndefined();
  });

  test('the pane state calls it a question, so no Enter is pressed at it', () => {
    expect(detectPaneState(SELECT)).toBe('ask_user_question');
    expect(detectPaneState(SELECT.slice(-3))).not.toBe('ask_user_question');
  });
});
