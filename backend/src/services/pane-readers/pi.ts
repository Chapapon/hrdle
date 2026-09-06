import type { PaneQuestion } from './index';
import { blankCursor, isFreeText, lastIndex, RULE, type PickerOption } from './shared';

/**
 * pi's own select prompt, `ctx.ui.select` - what any pi extension or tool that
 * asks a question with options is drawn with. Captured from a device on
 * 2026-09-06:
 *
 *   ────────────────────────────────────────
 *    どのおすすめを知りたいですか？               <- the question
 *    → 一蘭のおすすめメニュー                     <- the cursor row
 *      ラーメンの種類ごとのおすすめ
 *      ラーメン店のおすすめ
 *    ↑↓ navigate  enter select  escape/ctrl+c cancel
 *   ────────────────────────────────────────
 *
 * No row carries a number: the answer is the cursor walked to the row and
 * Enter, which is what `arrow` on a `column` axis says. Typing into it does
 * not answer it - text goes nowhere and the Enter after it takes the row the
 * cursor is on, which is how a spoken reply picked the first option.
 */
const HINT = /↑↓\s*navigate\s+enter\s+select/iu;
const CURSOR_ROW = /^\s*→\s/u;

export function readPiSelect(lines: string[]): PaneQuestion | undefined {
  const hint = lastIndex(lines, (l) => HINT.test(l));
  if (hint < 0) return undefined;
  const top = lastIndex(lines.slice(0, hint), (l) => RULE.test(l));
  if (top < 0) return undefined;
  const block = lines.slice(top + 1, hint);

  const questionAt = block.findIndex((l) => l.trim());
  if (questionAt < 0) return undefined;
  const cursorAt = lastIndex(block, (l) => CURSOR_ROW.test(l));
  if (cursorAt <= questionAt) return undefined;

  const rows: Array<{ option: PickerOption; index: number }> = [];
  for (let i = questionAt + 1; i < block.length; i++) {
    const label = blankCursor(block[i]).trim();
    if (!label) continue;
    rows.push({ option: { label, detail: '', ...(isFreeText(label) ? { freeText: true } : {}) }, index: i });
  }
  if (rows.length === 0) return undefined;
  const selected = rows.findIndex((r) => r.index === cursorAt);
  if (selected < 0) return undefined;

  return {
    question: block[questionAt].trim(),
    options: rows.map((r) => r.option),
    multiSelect: false,
    choiceInput: 'arrow',
    choiceAxis: 'column',
    choiceSelected: selected,
  };
}
