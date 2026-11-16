// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Claude Code PreToolUse hook: refuses a `git commit` whose message breaks the
 * convention in CONTRIBUTING.md ("Commit messages").
 *
 * It applies to agent sessions only, by choice: human commits are not checked
 * (docs/11 §6 lists the convention as judgement for people). An agent writes
 * a dozen commits a session and drifts towards narrating the diff, which is
 * exactly what the history must not read like, and a hook costs it nothing.
 *
 * Only the structure is checkable. "Why, not what" is not: the narration
 * check below catches the stock openings of a body that restates the diff,
 * and anything subtler is the reviewer's.
 *
 * Run by Node's own type stripping, with no imports outside `node:`, so it
 * works in a fresh clone or worktree before `pnpm install`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SUBJECT_MAX = 72;
// Not git's customary 72: the history's well-formed bodies wrap at up to 74,
// and a gate stricter than the examples it is taught from only teaches
// re-wrapping.
const BODY_LINE_MAX = 76;

/**
 * Subjects describe what the commit does when applied, as `git revert` and
 * `git merge` word theirs. These are the past-tense and third-person forms a
 * drifting subject starts with; a list rather than an `-ed` rule because
 * "Embed", "Seed" and "Shred" are imperatives.
 */
const NOT_IMPERATIVE =
  /^(added|adds|adding|fixed|fixes|fixing|updated|updates|updating|changed|changes|changing|removed|removes|removing|implemented|implements|implementing|refactored|refactors|refactoring|created|creates|creating|moved|moves|renamed|renames|improved|improves|deleted|deletes|introduced|introduces|wip)$/i;

/** A body opening like these is describing the diff, which the diff already does. */
const NARRATES_DIFF =
  /^(this (commit|change|pr|patch)\b|changes?:|(added|updated|changed|removed|modified|created|fixed) )/i;

/**
 * Known keys rather than git's `Token: value` shape, which would also read a
 * one-line body such as "Note: …" or "Changes: …" as a trailer and wave
 * through a commit that has no body at all.
 */
const TRAILER =
  /^(signed-off-by|co-authored-by|reviewed-by|acked-by|tested-by|reported-by|helped-by|suggested-by|refs|closes|fixes): \S/i;

export interface CommitInvocation {
  /** The message as git will record it, or null when the command does not say. */
  readonly message: string | null;
  /** A path given with `-F`, to be read relative to the session's cwd. */
  readonly messageFile: string | null;
  readonly signoff: boolean;
  readonly noVerify: boolean;
  /** `--no-edit`, `-C`, `--reuse-message`: the message already exists. */
  readonly reusesMessage: boolean;
}

/**
 * Message text is cut out of the command before flags are looked for, so a
 * body that mentions `--no-verify` or `git commit` is not mistaken for one.
 */
interface Split {
  readonly bare: string;
  /** Consumed in order by the `-m` values that refer to them. */
  readonly heredocs: string[];
  readonly quoted: readonly string[];
}

function split(command: string): Split {
  const heredocs: string[] = [];
  const quoted: string[] = [];
  const bare = command
    // Bash heredoc, as `-m "$(cat <<'EOF' … EOF)"` writes it.
    .replace(
      /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|\)|$)/g,
      (_match, _quote: string, _tag: string, body: string) => {
        heredocs.push(body);
        return ' __HEREDOC__ ';
      },
    )
    // PowerShell here-string: @' … '@ or @" … "@, closing at column 0.
    .replace(
      /@(['"])\r?\n([\s\S]*?)\r?\n\1@/g,
      (_match, _quote: string, body: string) => {
        heredocs.push(body);
        return ' __HEREDOC__ ';
      },
    )
    .replace(
      /"((?:[^"\\]|\\.)*)"|'([^']*)'/g,
      (_match, double: string | undefined, single: string | undefined) => {
        quoted.push(double === undefined ? (single ?? '') : unescape(double));
        return ` __Q${String(quoted.length - 1)}__ `;
      },
    );
  return { bare, heredocs, quoted };
}

function unescape(doubleQuoted: string): string {
  return doubleQuoted.replace(/\\(["\\$`])/g, '$1').replace(/\\n/g, '\n');
}

const GIT_COMMIT =
  /\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+commit\b([^;&|\n]*)/;

/** Finds a `git commit` in a shell command, or returns null if there is none. */
export function findCommit(command: string): CommitInvocation | null {
  const { bare, heredocs, quoted } = split(command);
  const found = GIT_COMMIT.exec(bare);
  if (found === null) {
    return null;
  }
  const args = found[1] ?? '';
  const has = (pattern: RegExp): boolean => pattern.test(args);
  const shortCluster = (letter: string): RegExp =>
    new RegExp(`(?:^|\\s)-[a-zA-Z]*${letter}[a-zA-Z]*(?=\\s|$)`);

  const messages: string[] = [];
  for (const m of args.matchAll(
    /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|\s+)(__HEREDOC__|__Q(\d+)__)/g,
  )) {
    const index = m[2];
    if (index === undefined) {
      const body = heredocs.shift();
      if (body !== undefined) {
        messages.push(body);
      }
    } else {
      const text = quoted[Number(index)];
      if (text !== undefined) {
        // `-m "$(cat <<'EOF' …)"`: the heredoc sits inside the quotes and was
        // cut out first, leaving only its placeholder in the quoted text.
        messages.push(
          text.includes('__HEREDOC__') ? (heredocs.shift() ?? '') : text,
        );
      }
    }
  }

  const file = /(?:^|\s)(?:-[a-zA-Z]*F|--file)(?:=|\s+)(__Q(\d+)__|\S+)/.exec(
    args,
  );
  let messageFile: string | null = null;
  if (file !== null) {
    messageFile =
      file[2] === undefined
        ? (file[1] ?? null)
        : (quoted[Number(file[2])] ?? null);
  }

  return {
    // git joins repeated -m values as separate paragraphs.
    message: messages.length > 0 ? messages.join('\n\n') : null,
    messageFile,
    signoff: has(/(?:^|\s)--signoff\b/) || has(shortCluster('s')),
    noVerify: has(/(?:^|\s)--no-verify\b/) || has(shortCluster('n')),
    reusesMessage: has(
      /(?:^|\s)(?:--no-edit|--reuse-message|--fixup|--squash|-C)\b/,
    ),
  };
}

/** What is wrong with a commit message, as sentences; empty when nothing is. */
export function checkMessage(raw: string, signedOff: boolean): string[] {
  const problems: string[] = [];
  const lines = raw.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const subject = lines[0]?.trim() ?? '';

  if (subject === '') {
    return ['The message is empty.'];
  }
  if (subject.length > SUBJECT_MAX) {
    problems.push(
      `The subject is ${String(subject.length)} characters; keep it to ${String(SUBJECT_MAX)} (aim for about 65).`,
    );
  }
  if (subject.endsWith('.')) {
    problems.push('The subject ends with a period.');
  }
  const firstWord = subject.replace(/^[\w./-]+:\s*/, '').split(/\s/)[0] ?? '';
  if (NOT_IMPERATIVE.test(firstWord)) {
    problems.push(
      `The subject starts with "${firstWord}"; write it in the imperative ("Add …", "Fix …"), as git does.`,
    );
  }

  if (lines.length > 1 && (lines[1] ?? '').trim() !== '') {
    problems.push('The subject is not followed by a blank line.');
  }

  const paragraphs = lines
    .slice(1)
    .join('\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const last = paragraphs.at(-1);
  const trailers =
    last?.split('\n').every((l) => TRAILER.test(l)) === true ? last : '';
  const prose = trailers === '' ? paragraphs : paragraphs.slice(0, -1);

  if (prose.length === 0) {
    problems.push(
      'There is no body. Say why the change is needed: what was wrong, why this approach and not the obvious one, which doc or ADR it implements.',
    );
  } else {
    const opening = prose[0] ?? '';
    if (NARRATES_DIFF.test(opening)) {
      problems.push(
        'The body opens by describing the diff. The diff already says what changed; the body says why.',
      );
    }
  }

  for (const line of lines.slice(2)) {
    // Long tokens (URLs, paths, the red test output quoted with an indent)
    // cannot be wrapped and are left alone.
    if (
      line.length > BODY_LINE_MAX &&
      !line.startsWith('    ') &&
      !line.includes('://') &&
      !TRAILER.test(line)
    ) {
      problems.push(
        `A body line is ${String(line.length)} characters; wrap prose at ${String(BODY_LINE_MAX)}: "${line.slice(0, 40)}…"`,
      );
      break;
    }
  }

  if (!signedOff && !/^Signed-off-by: /m.test(trailers)) {
    problems.push('No sign-off: commit with -s (DCO, CONTRIBUTING.md).');
  }
  return problems;
}

/**
 * The hook's verdict on one shell command: the problems to send back, or an
 * empty list to let it run.
 */
export function review(
  command: string,
  readMessageFile: (path: string) => string | null,
): string[] {
  const commit = findCommit(command);
  if (commit === null) {
    return [];
  }
  const problems: string[] = [];
  if (commit.noVerify) {
    problems.push('--no-verify skips the repository hooks; drop it.');
  }
  let message = commit.message;
  if (message === null && commit.messageFile !== null) {
    message = readMessageFile(commit.messageFile);
    if (message === null) {
      problems.push(`The message file ${commit.messageFile} cannot be read.`);
      return problems;
    }
  }
  if (message === null) {
    if (!commit.reusesMessage) {
      problems.push(
        'The message cannot be read from the command. Pass it with -m "$(cat <<\'EOF\' … EOF)", a PowerShell here-string, or -F <file>.',
      );
    }
    return problems;
  }
  return [...problems, ...checkMessage(message, commit.signoff)];
}

interface HookInput {
  readonly command: string;
  readonly cwd: string;
}

function parseHookInput(raw: string): HookInput | null {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const toolInput: unknown = Reflect.get(data, 'tool_input');
  const cwd: unknown = Reflect.get(data, 'cwd');
  if (typeof toolInput !== 'object' || toolInput === null) {
    return null;
  }
  const command: unknown = Reflect.get(toolInput, 'command');
  if (typeof command !== 'string') {
    return null;
  }
  return { command, cwd: typeof cwd === 'string' ? cwd : process.cwd() };
}

function main(): void {
  // Fails open: a hook that crashes must not wedge every Bash call. Exit 2 is
  // the one code Claude Code treats as "blocked, here is why".
  let input: HookInput | null;
  try {
    input = parseHookInput(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (input === null) {
    return;
  }
  const { cwd } = input;
  const problems = review(input.command, (path) => {
    try {
      return readFileSync(resolve(cwd, path), 'utf8');
    } catch {
      return null;
    }
  });
  if (problems.length > 0) {
    process.stderr.write(
      [
        'Commit refused by .claude/hooks/commit-message.ts:',
        ...problems.map((p) => `- ${p}`),
        '',
        'Convention: CONTRIBUTING.md, "Commit messages". Rewrite the message and commit again.',
        '',
      ].join('\n'),
    );
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  main();
}
