// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * `POST …/publish/test` (ADR-0054): the whole schedule email run, rendered
 * by the server and sent to one address.
 *
 * The page posts its template rather than finished messages, so what arrives
 * is what the server's renderer makes of it. That renderer is the one `send`
 * will use, which a message rendered here would leave untested.
 */
import * as v from 'valibot';

import { request, type Failure } from './http';

const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const FORBIDDEN = 'https://evp.example/errors/forbidden';

/** Which run: one day, or every day of a festival. */
export type TestScope =
  | { readonly kind: 'event'; readonly id: string }
  | { readonly kind: 'festival'; readonly id: string };

export interface TestSendInput {
  readonly recipient: string;
  readonly locale: 'fr' | 'en';
  readonly subject: string;
  readonly bodyHtml: string;
}

const summarySchema = v.object({
  sent: v.pipe(v.number(), v.integer(), v.minValue(0)),
  skipped_opted_out: v.pipe(v.number(), v.integer(), v.minValue(0)),
  no_address: v.array(v.string()),
  failed: v.nullable(
    v.object({
      name: v.string(),
      reason: v.picklist(['refused', 'relay_unavailable', 'render_failed']),
      detail: v.string(),
    }),
  ),
});

export type TestSendSummary = v.InferOutput<typeof summarySchema>;

export type TestSendResult =
  | { readonly ok: true; readonly summary: TestSendSummary }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'forbidden' | 'refused' | 'unavailable';
      readonly detail: string | null;
    };

function scopePath(orgId: string, scope: TestScope): string {
  const kind = scope.kind === 'event' ? 'events' : 'festivals';
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/${kind}/${encodeURIComponent(scope.id)}/publish/test`;
}

export async function sendTestRun(
  orgId: string,
  scope: TestScope,
  input: TestSendInput,
): Promise<TestSendResult> {
  const result = await request(
    {
      method: 'POST',
      path: scopePath(orgId, scope),
      body: {
        test_recipient: input.recipient,
        locale: input.locale,
        template: { subject: input.subject, body_html: input.bodyHtml },
      },
    },
    summarySchema,
  );
  return result.ok
    ? { ok: true, summary: result.value }
    : rejectionFor(result.failure);
}

function rejectionFor(failure: Failure): TestSendResult {
  if (failure.reason !== 'rejected') {
    return { ok: false, reason: 'unavailable', detail: null };
  }
  const { problem } = failure;
  const detail = problem.detail ?? problem.title;
  if (problem.type === VALIDATION_FAILED) {
    return { ok: false, reason: 'invalid', detail };
  }
  if (problem.type === FORBIDDEN) {
    return { ok: false, reason: 'forbidden', detail };
  }
  return { ok: false, reason: 'refused', detail };
}
