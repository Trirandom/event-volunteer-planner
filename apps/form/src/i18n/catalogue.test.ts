// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { auditCatalogues } from '@evp/shared/i18n';
import { describe, expect, it } from 'vitest';

import en from './en';
import fr from './fr';

// docs/16 §7: key parity is a type error already; this is the rest.
describe('form catalogues', () => {
  it('are valid ICU, agree on arguments, and format no dates themselves', () => {
    expect(auditCatalogues({ fr, en })).toEqual([]);
  });
});
