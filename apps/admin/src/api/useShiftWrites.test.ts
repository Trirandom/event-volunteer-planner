// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as events from './events';
import * as shifts from './shifts';
import { applyShiftOps } from './useShiftWrites';
import type { BoardOp, ShiftOp } from '../board/edit';

const OPEN = Temporal.Instant.from('2026-09-05T08:00:00Z').epochMilliseconds;
const HOUR = 3_600_000;

const CREATE: ShiftOp = {
  kind: 'create',
  eventId: 'fri',
  locationId: 'bar',
  startMs: OPEN,
  endMs: OPEN + 2 * HOUR,
  requiredCount: 2,
};

const PATCH: ShiftOp = {
  kind: 'patch',
  eventId: 'fri',
  shiftId: 'a',
  version: 3,
  startMs: OPEN,
  endMs: OPEN + HOUR,
};

const DELETE: ShiftOp = {
  kind: 'delete',
  eventId: 'fri',
  shiftId: 'b',
  version: 4,
};

/** The day itself, widened so the slots behind it have somewhere to live
 * (ADR-0044). */
const EXTEND: BoardOp = {
  kind: 'extend-event',
  eventId: 'fri',
  version: 7,
  startMs: OPEN,
  endMs: OPEN + 14 * HOUR,
};

function written(): shifts.ShiftWriteResult {
  return {
    ok: true,
    shift: {
      id: 'a',
      event_id: 'fri',
      location_id: 'bar',
      period: { start: '2026-09-05T08:00:00Z', end: '2026-09-05T10:00:00Z' },
      required_count: 1,
      created_at: '2026-09-05T08:00:00Z',
      updated_at: '2026-09-05T08:00:00Z',
      version: 2,
    },
    operationId: 'op-1',
  };
}

/** The day as the server answers with it once it has been widened. */
const EVENT: events.Event = {
  id: 'fri',
  festival_id: null,
  name: 'Friday',
  slug: 'fri',
  timezone: 'Europe/Paris',
  period: { start: '2026-09-05T08:00:00Z', end: '2026-09-05T22:00:00Z' },
  public_period: {
    start: '2026-09-05T08:00:00Z',
    end: '2026-09-05T20:00:00Z',
  },
  status: 'draft',
  color: 0,
  created_at: '2026-09-05T08:00:00Z',
  updated_at: '2026-09-05T08:00:00Z',
  version: 8,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyShiftOps', () => {
  it('sends each operation as the verb it is', async () => {
    const create = vi.spyOn(shifts, 'createShift').mockResolvedValue(written());
    const patch = vi
      .spyOn(shifts, 'patchShiftPeriod')
      .mockResolvedValue(written());
    const remove = vi
      .spyOn(shifts, 'deleteShift')
      .mockResolvedValue({ ok: true });

    const outcome = await applyShiftOps('org-1', [DELETE, PATCH, CREATE]);

    expect(outcome).toEqual({ applied: 3, rejection: null });
    expect(remove).toHaveBeenCalledWith('org-1', 'fri', 'b', 4);
    expect(patch).toHaveBeenCalledWith('org-1', 'fri', 'a', 3, {
      start: '2026-09-05T08:00:00Z',
      end: '2026-09-05T09:00:00Z',
    });
    expect(create).toHaveBeenCalledWith('org-1', 'fri', {
      locationId: 'bar',
      period: {
        start: '2026-09-05T08:00:00Z',
        end: '2026-09-05T10:00:00Z',
      },
      requiredCount: 2,
    });
  });

  it('runs them in the order the plan gave, never in parallel', async () => {
    const order: string[] = [];
    // `Promise.resolve` rather than an `async` arrow with nothing to await:
    // `require-await` is right that an `async` with no `await` in it is a
    // promise-shaped lie.
    vi.spyOn(shifts, 'deleteShift').mockImplementation(() => {
      order.push('delete');
      return Promise.resolve({ ok: true });
    });
    vi.spyOn(shifts, 'createShift').mockImplementation(() => {
      order.push('create');
      return Promise.resolve(written());
    });

    await applyShiftOps('org-1', [DELETE, CREATE]);

    expect(order).toEqual(['delete', 'create']);
  });

  /** Half a gesture is not a smaller gesture. Stopping keeps the database as
   * close as possible to a state the coordinator can still recognise, and the
   * count is what the view says out loud. */
  it('stops at the first refusal and reports what did land', async () => {
    vi.spyOn(shifts, 'deleteShift').mockResolvedValue({ ok: true });
    vi.spyOn(shifts, 'patchShiftPeriod').mockResolvedValue({
      ok: false,
      rejection: { reason: 'conflict', detail: 'now at version 9' },
    });
    const create = vi.spyOn(shifts, 'createShift').mockResolvedValue(written());

    const outcome = await applyShiftOps('org-1', [DELETE, PATCH, CREATE]);

    expect(outcome).toEqual({
      applied: 1,
      rejection: { reason: 'conflict', detail: 'now at version 9' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('asks for nothing when the plan is empty', async () => {
    const create = vi.spyOn(shifts, 'createShift').mockResolvedValue(written());

    expect(await applyShiftOps('org-1', [])).toEqual({
      applied: 0,
      rejection: null,
    });
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * A day is widened before the slot that needed it, and the sequencing is a
   * database rule rather than tidiness: `shifts_within_event_check` is
   * `INITIALLY IMMEDIATE`, so a slot sent first is refused at the statement
   * and — because this function stops at the first refusal — the plan ends
   * there with the day still too short.
   */
  it('widens the day before writing the slot that needs it', async () => {
    const order: string[] = [];
    const widen = vi
      .spyOn(events, 'patchEventPeriod')
      .mockImplementation(() => {
        order.push('event');
        return Promise.resolve({ ok: true, event: EVENT });
      });
    const create = vi.spyOn(shifts, 'createShift').mockImplementation(() => {
      order.push('shift');
      return Promise.resolve(written());
    });

    const outcome = await applyShiftOps('org-1', [EXTEND, CREATE]);

    expect(outcome).toEqual({ applied: 2, rejection: null });
    expect(order).toEqual(['event', 'shift']);
    expect(widen).toHaveBeenCalledWith('org-1', 'fri', 7, {
      start: '2026-09-05T08:00:00Z',
      end: '2026-09-05T22:00:00Z',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  /** And a day that could not be widened takes its slots down with it, rather
   * than leaving the board to collect a 422 per slot. */
  it('does not write the slots when the day refuses to move', async () => {
    vi.spyOn(events, 'patchEventPeriod').mockResolvedValue({
      ok: false,
      rejection: { reason: 'conflict', detail: 'now at version 9' },
    });
    const create = vi.spyOn(shifts, 'createShift').mockResolvedValue(written());

    expect(await applyShiftOps('org-1', [EXTEND, CREATE])).toEqual({
      applied: 0,
      rejection: { reason: 'conflict', detail: 'now at version 9' },
    });
    expect(create).not.toHaveBeenCalled();
  });
});
