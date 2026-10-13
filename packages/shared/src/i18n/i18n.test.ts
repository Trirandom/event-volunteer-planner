// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import {
  auditCatalogues,
  createEvpI18n,
  flattenCatalogue,
  negotiateLocale,
} from './index';

const fr = {
  volunteers: '{count, plural, one {# bénévole} other {# bénévoles}}',
  greeting: 'Bonjour {name}',
  apostrophe: 'L’adresse n’est pas valide',
  nested: { role: '{role, select, lead {Responsable} other {Bénévole}}' },
};

const en: typeof fr = {
  volunteers: '{count, plural, one {# volunteer} other {# volunteers}}',
  greeting: 'Hello {name}',
  apostrophe: 'The address isn’t valid',
  nested: { role: '{role, select, lead {Lead} other {Volunteer}}' },
};

function make() {
  return createEvpI18n({ fr, others: { en: async () => Promise.resolve(en) } });
}

describe('ICU rendering', () => {
  // docs/16 §6: the reason a hand-rolled `n > 1 ? 's' : ''` is not allowed.
  it('puts 0 in the singular in French and the plural in English', async () => {
    const i18n = make();
    expect(i18n.t('volunteers', { count: 0 })).toBe('0 bénévole');
    expect(i18n.t('volunteers', { count: 2 })).toBe('2 bénévoles');
    await i18n.setLocale('en');
    expect(i18n.t('volunteers', { count: 0 })).toBe('0 volunteers');
    expect(i18n.t('volunteers', { count: 1 })).toBe('1 volunteer');
  });

  it('groups thousands by the locale', async () => {
    const i18n = make();
    // French groups with a narrow no-break space.
    expect(i18n.t('volunteers', { count: 1500 })).toBe('1 500 bénévoles');
    await i18n.setLocale('en');
    expect(i18n.t('volunteers', { count: 1500 })).toBe('1,500 volunteers');
  });

  it('interpolates, selects and resolves nested keys', () => {
    const i18n = make();
    expect(i18n.t('greeting', { name: 'Zoé' })).toBe('Bonjour Zoé');
    expect(i18n.t('nested.role', { role: 'lead' })).toBe('Responsable');
    expect(i18n.t('nested.role', { role: 'volunteer' })).toBe('Bénévole');
  });

  it('keeps typographic apostrophes literal', () => {
    expect(make().t('apostrophe')).toBe('L’adresse n’est pas valide');
  });

  it('does not treat a `<` as markup', () => {
    const i18n = createEvpI18n({
      fr: { lt: 'moins de <5> places' },
      others: { en: async () => Promise.resolve({ lt: 'under <5> places' }) },
    });
    expect(i18n.t('lt')).toBe('moins de <5> places');
  });
});

describe('setLocale', () => {
  it('starts in French and loads English on demand', async () => {
    let loads = 0;
    const i18n = createEvpI18n({
      fr,
      others: {
        en: async () => {
          loads += 1;
          return Promise.resolve(en);
        },
      },
    });
    expect(i18n.locale.value).toBe('fr');
    expect(loads).toBe(0);
    await i18n.setLocale('en');
    await i18n.setLocale('fr');
    await i18n.setLocale('en');
    expect(i18n.locale.value).toBe('en');
    expect(loads).toBe(1);
  });

  it('lets the later of two overlapping switches win', async () => {
    let release: (value: typeof fr) => void = () => undefined;
    const i18n = createEvpI18n({
      fr,
      others: {
        en: async () =>
          new Promise<typeof fr>((resolve) => (release = resolve)),
      },
    });
    const slow = i18n.setLocale('en');
    await i18n.setLocale('fr');
    release(en);
    await slow;
    expect(i18n.locale.value).toBe('fr');
  });
});

describe('negotiateLocale', () => {
  it('matches on the primary subtag, in order', () => {
    expect(negotiateLocale(['de-DE', 'en-GB', 'fr'])).toBe('en');
    expect(negotiateLocale(['fr-CA'])).toBe('fr');
    expect(negotiateLocale(['FR_be'])).toBe('fr');
  });

  it('skips blanks and returns null when nothing matches', () => {
    expect(negotiateLocale([null, undefined, '', 'de'])).toBeNull();
    expect(negotiateLocale([])).toBeNull();
  });
});

describe('auditCatalogues', () => {
  it('passes matching catalogues', () => {
    expect(auditCatalogues({ fr, en })).toEqual([]);
  });

  it('flattens to dotted keys', () => {
    expect(flattenCatalogue({ a: { b: 'x' }, c: 'y' })).toEqual([
      ['a.b', 'x'],
      ['c', 'y'],
    ]);
  });

  it('reports missing and extra keys against the first locale', () => {
    expect(
      auditCatalogues({ fr: { a: 'x', b: 'y' }, en: { a: 'x', c: 'z' } }),
    ).toEqual([
      { key: 'b', locale: 'en', problem: 'missing (present in fr)' },
      { key: 'c', locale: 'en', problem: 'not in fr' },
    ]);
  });

  it('reports a translation that asks for different arguments', () => {
    const problems = auditCatalogues({
      fr: { a: 'Bonjour {name}' },
      en: { a: 'Hello {nmae}' },
    });
    expect(problems).toEqual([
      {
        key: 'a',
        locale: 'en',
        problem: "arguments {nmae} differ from fr's {name}",
      },
    ]);
  });

  it('sees arguments inside plural and select branches', () => {
    const problems = auditCatalogues({
      fr: {
        a: '{n, plural, one {# poste à {zone}} other {# postes à {zone}}}',
      },
      en: { a: '{n, plural, one {# post} other {# posts}}' },
    });
    expect(problems.map((p) => p.problem)).toEqual([
      "arguments {n} differ from fr's {n, zone}",
    ]);
  });

  it('rejects invalid ICU and empty messages', () => {
    const problems = auditCatalogues({ fr: { a: 'Bonjour {name', b: ' ' } });
    expect(problems.map((p) => [p.key, p.problem.split(':')[0]])).toEqual([
      ['a', 'invalid ICU'],
      ['b', 'empty message'],
    ]);
  });

  // docs/16 §6: ICU's own date formatting would use the viewer's timezone.
  it('rejects a message that formats a date or time itself', () => {
    const problems = auditCatalogues({
      fr: { a: 'Le {when, date, long}', b: 'à {when, time, short}' },
    });
    expect(problems.map((p) => p.key)).toEqual(['a', 'b']);
  });
});
