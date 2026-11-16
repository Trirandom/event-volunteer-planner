// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { checkMessage, findCommit, review } from './commit-message';

const GOOD = [
  'Give the flat language its own shared stylesheet',
  '',
  'Each slab knob was restated per component, so a change of depth had to',
  'be made in six places and was made in four. ADR-0047.',
  '',
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
].join('\n');

const noFile = (): string | null => null;

function bashHeredoc(message: string, flags = '-s'): string {
  return `git add a.ts && git commit ${flags} -m "$(cat <<'EOF'\n${message}\nEOF\n)"`;
}

describe('findCommit', () => {
  it('ignores a command that does not commit', () => {
    expect(findCommit('git log --oneline -5')).toBeNull();
    expect(findCommit('pnpm vitest run')).toBeNull();
  });

  it('ignores "git commit" written inside a message of another command', () => {
    expect(findCommit(`echo "remember to git commit -n"`)).toBeNull();
  });

  it('reads the Bash heredoc form', () => {
    const commit = findCommit(bashHeredoc(GOOD));
    expect(commit?.message).toBe(GOOD);
    expect(commit?.signoff).toBe(true);
  });

  it('reads a PowerShell here-string', () => {
    const commit = findCommit(`git commit -s -m @'\r\n${GOOD}\r\n'@`);
    expect(commit?.message?.replace(/\r\n/g, '\n')).toBe(GOOD);
  });

  it('joins repeated -m values as paragraphs, as git does', () => {
    const commit = findCommit(`git commit -m "Fix it" -m 'Because.'`);
    expect(commit?.message).toBe('Fix it\n\nBecause.');
  });

  it('finds a message file given with -F', () => {
    expect(findCommit('git commit -s -F msg.txt')?.messageFile).toBe('msg.txt');
  });

  it('sees -s inside a short-flag cluster and through git -C', () => {
    expect(findCommit(`git -C ../wt commit -asm "x"`)?.signoff).toBe(true);
  });

  it('does not take --no-verify from the message text', () => {
    const commit = findCommit(bashHeredoc('Drop --no-verify\n\nWhy.'));
    expect(commit?.noVerify).toBe(false);
  });

  it('sees --no-verify among the flags', () => {
    expect(findCommit(bashHeredoc(GOOD, '-s --no-verify'))?.noVerify).toBe(
      true,
    );
  });
});

describe('checkMessage', () => {
  it('accepts a message in the house style', () => {
    expect(checkMessage(GOOD, true)).toEqual([]);
  });

  it('accepts a Signed-off-by trailer written into the message', () => {
    expect(
      checkMessage(`${GOOD}\nSigned-off-by: A <a@example.org>`, false),
    ).toEqual([]);
  });

  it('refuses a message with no sign-off', () => {
    expect(checkMessage(GOOD, false)).toEqual([
      expect.stringContaining('No sign-off'),
    ]);
  });

  it('refuses a subject-only message', () => {
    expect(checkMessage('Fix the overlap check', true)).toEqual([
      expect.stringContaining('no body'),
    ]);
  });

  it('counts a body of trailers alone as no body', () => {
    const message =
      'Fix the overlap check\n\nCo-Authored-By: X <x@example.org>';
    expect(checkMessage(message, true)).toEqual([
      expect.stringContaining('no body'),
    ]);
  });

  it('refuses a body that narrates the diff', () => {
    for (const opening of [
      'This commit adds a check.',
      'Changes: a check.',
      'Updated the handler to check.',
    ]) {
      expect(
        checkMessage(`Check overlaps\n\n${opening}`, true),
        opening,
      ).toEqual([expect.stringContaining('describing the diff')]);
    }
  });

  it('refuses a past-tense or third-person subject, behind an area prefix too', () => {
    for (const subject of [
      'Added a check',
      'Fixes the check',
      'admin: updated nav',
    ]) {
      expect(checkMessage(`${subject}\n\nWhy.`, true), subject).toEqual([
        expect.stringContaining('imperative'),
      ]);
    }
  });

  it('accepts imperatives that end in -ed', () => {
    expect(checkMessage('Embed the mark\n\nWhy.', true)).toEqual([]);
  });

  it('allows a 72-character subject and refuses 73', () => {
    const at = (n: number): string => `Fix ${'x'.repeat(n - 4)}\n\nWhy.`;
    expect(checkMessage(at(72), true)).toEqual([]);
    expect(checkMessage(at(73), true)).toEqual([
      expect.stringContaining('73 characters'),
    ]);
  });

  it('refuses a trailing period and a missing blank line', () => {
    expect(checkMessage('Fix it.\nWhy.', true)).toEqual([
      expect.stringContaining('period'),
      expect.stringContaining('blank line'),
    ]);
  });

  it('refuses unwrapped prose but not a URL or an indented quote', () => {
    const long = 'word '.repeat(16).trim();
    expect(checkMessage(`Fix it\n\n${long}`, true)).toEqual([
      expect.stringContaining('wrap prose'),
    ]);
    const url = `See https://example.org/${'a'.repeat(80)}`;
    const quote = `    ${'assertion failed '.repeat(6)}`;
    expect(checkMessage(`Fix it\n\nWhy.\n\n${url}\n${quote}`, true)).toEqual(
      [],
    );
  });
});

describe('review', () => {
  it('lets a non-commit command through', () => {
    expect(review('ls', noFile)).toEqual([]);
  });

  it('refuses a commit whose message it cannot see', () => {
    expect(review('git commit -s', noFile)).toEqual([
      expect.stringContaining('cannot be read from the command'),
    ]);
  });

  it('lets an amend that keeps its message through', () => {
    expect(review('git commit --amend --no-edit', noFile)).toEqual([]);
  });

  it('checks the contents of a -F file', () => {
    expect(review('git commit -s -F m.txt', () => GOOD)).toEqual([]);
    expect(review('git commit -s -F m.txt', () => 'wip')).toEqual(
      expect.arrayContaining([expect.stringContaining('"wip"')]),
    );
  });

  it('refuses --no-verify on an otherwise good commit', () => {
    expect(review(bashHeredoc(GOOD, '-s --no-verify'), noFile)).toEqual([
      expect.stringContaining('--no-verify'),
    ]);
  });
});
