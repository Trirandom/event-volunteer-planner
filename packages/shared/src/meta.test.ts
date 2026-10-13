// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { metaSchema } from './meta.js';

describe('the /api/v1/meta parser', () => {
  it('accepts the documented response', () => {
    const result = v.safeParse(metaSchema, {
      version: '0.4.1',
      commit: 'a1b2c3d',
      source_url: 'https://github.com/Trirandom/event-volunteer-planner',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a source_url that is not a URL, rather than rendering it', () => {
    const result = v.safeParse(metaSchema, {
      version: '0.4.1',
      commit: 'a1b2c3d',
      source_url: 'javascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a response missing the source link entirely', () => {
    const result = v.safeParse(metaSchema, {
      version: '0.4.1',
      commit: 'a1b2c3d',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty version, which would render as a blank About panel', () => {
    const result = v.safeParse(metaSchema, {
      version: '',
      commit: 'a1b2c3d',
      source_url: 'https://example.org/src',
    });
    expect(result.success).toBe(false);
  });
});
