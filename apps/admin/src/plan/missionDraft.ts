// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * What the missions form holds, and what it would send.
 *
 * Split out of the component for the same reason `eventDraft.ts` is: the part
 * that can be wrong without anybody noticing is not the layout, it is the
 * answer to "did the coordinator actually change this, and does saving it
 * overwrite something they cannot see".
 *
 * That second half is the whole of this module's difficulty. One box on screen
 * stands for N rows in the database (`missionCatalog.ts`), and when those rows
 * disagree — Open Air's bar is behind the main stage, the club's bar is in the
 * club — an empty box does not mean "clear the address". It means "the days
 * differ and I have not said which way". A form that could not tell those two
 * apart would silently flatten five addresses into one the first time somebody
 * corrected a typo in the name, which is why a shared field is `string | null`
 * here rather than just `string`.
 */
import type { LocationChanges } from '../api/locations';
import { missionKey, missionKind, type Mission } from './missionCatalog';

/**
 * A field that stands for one value per day.
 *
 * `null` is "leave every day's own value where it is" — the state a field is
 * born in when the days disagree, and the only state in which the form sends
 * nothing for it. A string, including `''`, is a value to write to *all* of
 * them; `''` is how a coordinator says "there is nothing to put here", which
 * the API stores as `NULL`.
 */
export type Shared = string | null;

export interface MissionDraft {
  readonly name: string;
  readonly description: Shared;
  readonly address: Shared;
  /** A postal address a map or courier can resolve. Zone missions only. */
  readonly exactAddress: Shared;
  /** `"<latitude>, <longitude>"`, decimal degrees. Zone missions only; parsed
   * by [`parseCoordinates`] before it is sent. */
  readonly coordinates: Shared;
  /** Whole numbers as typed, parsed by [`parseCount`] before they are sent.
   * Blank is "no bound". */
  readonly minVolunteers: Shared;
  readonly maxVolunteers: Shared;
  /**
   * How the volunteer form offers the mission. Zone missions only. `null`
   * means what it means for a text field: the days disagree and the
   * coordinator has not picked a side, so nothing is sent — and, on a post,
   * that there is nothing of its own to say (it takes its zone's values).
   */
  readonly checkedByDefault: boolean | null;
  readonly adultsOnly: boolean | null;
}

/**
 * The add form's draft.
 *
 * Every field is a plain string, because nothing can vary on a mission that
 * does not exist yet — there are no rows to disagree. Structurally a
 * [`MissionDraft`], so the same `missionProblem` and `newMissionInput` read it,
 * and `v-model` gets a `string` to write rather than a `string | null`.
 */
export interface NewMissionDraft {
  name: string;
  description: string;
  address: string;
  exactAddress: string;
  coordinates: string;
  minVolunteers: string;
  maxVolunteers: string;
  checkedByDefault: boolean;
  adultsOnly: boolean;
}

/** The stored mission, as the fields that would reproduce it. */
export function draftOf(mission: Mission): MissionDraft {
  return {
    name: mission.name,
    description: mission.descriptionVaries ? null : (mission.description ?? ''),
    address: mission.addressVaries ? null : (mission.address ?? ''),
    exactAddress: mission.exactAddressVaries
      ? null
      : (mission.exactAddress ?? ''),
    coordinates: mission.coordinatesVaries
      ? null
      : (mission.coordinates?.replace(',', ', ') ?? ''),
    minVolunteers: mission.minVolunteersVaries
      ? null
      : (mission.minVolunteers ?? ''),
    maxVolunteers: mission.maxVolunteersVaries
      ? null
      : (mission.maxVolunteers ?? ''),
    checkedByDefault: mission.checkedByDefaultVaries
      ? null
      : mission.checkedByDefault,
    adultsOnly: mission.adultsOnlyVaries ? null : mission.adultsOnly,
  };
}

/** A blank field and a field of spaces both mean "nothing here", which the
 * schema spells `NULL` (`locations_description_not_blank`). */
function stated(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Decimal latitude/longitude, parsed from the one text box the form shows. */
export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * `"48.8566, 2.3522"` → `{ latitude, longitude }`, or `null` for a blank
 * field. Anything else — one number, text, out-of-range degrees — is a
 * [`Coordinates`]`|null` union with no third case, so an unparsable string is
 * also `null`; [`missionProblem`] is what tells that apart from "empty on
 * purpose" for the form.
 */
export function parseCoordinates(value: string): Coordinates | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const parts = trimmed.split(',');
  if (parts.length !== 2) {
    return null;
  }
  const [latitudeText, longitudeText] = parts;
  const latitude = Number(latitudeText?.trim());
  const longitude = Number(longitudeText?.trim());
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

/** `smallint`'s ceiling. Past it the server would refuse the write for a
 * reason no coordinator can act on, so the form refuses it first. */
const MAX_COUNT = 32767;

/**
 * A volunteer bound as typed → a whole number, or `null` for a blank field.
 *
 * `floor` is the smallest value that bound can take — `0` for a minimum (a
 * post that is fine left empty), `1` for a maximum (a ceiling of nobody is a
 * mission that should not exist). Like [`parseCoordinates`], anything
 * unparsable is also `null`, and [`missionProblem`] is what tells the two
 * apart.
 */
export function parseCount(value: string, floor: 0 | 1): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const count = Number(trimmed);
  return count < floor || count > MAX_COUNT ? null : count;
}

function countInvalid(value: Shared, floor: 0 | 1): boolean {
  return (
    value !== null && value.trim() !== '' && parseCount(value, floor) === null
  );
}

/**
 * One shared field's contribution to the patch, or `undefined` for "do not
 * send this key".
 *
 * Three cases and they are genuinely three. Untouched while the days disagree
 * sends nothing. Touched while the days disagree always sends, even if what
 * was typed happens to match one of them, because unifying N rows on a value
 * one of them already had is still a change to the others. Otherwise it sends
 * only when the value actually moved.
 */
function sharedChange(
  draft: Shared,
  storedValue: string | null,
  varies: boolean,
): string | null | undefined {
  if (draft === null) {
    return undefined;
  }
  const next = stated(draft);
  if (varies) {
    return next;
  }
  return next === storedValue ? undefined : next;
}

/**
 * The same three-case rule as [`sharedChange`], compared by parsed value
 * rather than by text: the stored coordinates are digits with no space
 * (`coordinatesOf` in `missionCatalog.ts`) and the field the coordinator sees
 * has one, so a plain string comparison would call every untouched field a
 * change and leave "Save" permanently enabled.
 */
function coordinatesChange(
  draft: Shared,
  storedValue: string | null,
  varies: boolean,
): Coordinates | null | undefined {
  if (draft === null) {
    return undefined;
  }
  const next = parseCoordinates(draft);
  if (varies) {
    return next;
  }
  const stored = storedValue === null ? null : parseCoordinates(storedValue);
  const unchanged =
    (next === null && stored === null) ||
    (next !== null &&
      stored !== null &&
      next.latitude === stored.latitude &&
      next.longitude === stored.longitude);
  return unchanged ? undefined : next;
}

/** The same three-case rule again, compared as numbers so `"04"` and the
 * stored `"4"` are not a change. */
function countChange(
  draft: Shared,
  storedValue: string | null,
  varies: boolean,
  floor: 0 | 1,
): number | null | undefined {
  if (draft === null) {
    return undefined;
  }
  const next = parseCount(draft, floor);
  if (varies) {
    return next;
  }
  const stored = storedValue === null ? null : Number(storedValue);
  return next === stored ? undefined : next;
}

/**
 * The three-case rule once more, for a flag. There is no blank to normalise,
 * so all that is left is "picked while the days disagree always sends".
 */
function flagChange(
  draft: boolean | null,
  storedValue: boolean | null,
  varies: boolean,
): boolean | undefined {
  if (draft === null) {
    return undefined;
  }
  if (varies) {
    return draft;
  }
  return draft === storedValue ? undefined : draft;
}

/**
 * What this draft would send, or `null` if it would send nothing.
 *
 * The name is compared against the mission's own spelling rather than against
 * each row's. Two days holding `Bar` and `BAR` are one mission, and a
 * coordinator who opens the card and saves it without touching the name has
 * not asked for the second one to be corrected — so an untouched name sends
 * nothing and leaves both. Editing it does rename every day, which is what
 * renaming a mission means.
 */
export function draftChanges(
  mission: Mission,
  draft: MissionDraft,
): LocationChanges | null {
  const changes: {
    name?: string;
    description?: string | null;
    address?: string | null;
    exactAddress?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    minVolunteers?: number | null;
    maxVolunteers?: number | null;
    checkedByDefault?: boolean;
    adultsOnly?: boolean;
  } = {};

  const name = draft.name.trim();
  if (name !== '' && name !== mission.name) {
    changes.name = name;
  }

  const description = sharedChange(
    draft.description,
    mission.description,
    mission.descriptionVaries,
  );
  if (description !== undefined) {
    changes.description = description;
  }

  const address = sharedChange(
    draft.address,
    mission.address,
    mission.addressVaries,
  );
  if (address !== undefined) {
    changes.address = address;
  }

  const exactAddress = sharedChange(
    draft.exactAddress,
    mission.exactAddress,
    mission.exactAddressVaries,
  );
  if (exactAddress !== undefined) {
    changes.exactAddress = exactAddress;
  }

  const coordinates = coordinatesChange(
    draft.coordinates,
    mission.coordinates,
    mission.coordinatesVaries,
  );
  if (coordinates !== undefined) {
    changes.latitude = coordinates?.latitude ?? null;
    changes.longitude = coordinates?.longitude ?? null;
  }

  const minVolunteers = countChange(
    draft.minVolunteers,
    mission.minVolunteers,
    mission.minVolunteersVaries,
    0,
  );
  if (minVolunteers !== undefined) {
    changes.minVolunteers = minVolunteers;
  }

  const maxVolunteers = countChange(
    draft.maxVolunteers,
    mission.maxVolunteers,
    mission.maxVolunteersVaries,
    1,
  );
  if (maxVolunteers !== undefined) {
    changes.maxVolunteers = maxVolunteers;
  }

  // Checked here and not left to the form hiding the boxes: the server refuses
  // either key on a post with a 422, and one stray key would fail every day of
  // the fan-out for a field the coordinator never saw.
  if (missionKind(mission) === 'zone') {
    const checkedByDefault = flagChange(
      draft.checkedByDefault,
      mission.checkedByDefault,
      mission.checkedByDefaultVaries,
    );
    if (checkedByDefault !== undefined) {
      changes.checkedByDefault = checkedByDefault;
    }
    const adultsOnly = flagChange(
      draft.adultsOnly,
      mission.adultsOnly,
      mission.adultsOnlyVaries,
    );
    if (adultsOnly !== undefined) {
      changes.adultsOnly = adultsOnly;
    }
  }

  return Object.keys(changes).length === 0 ? null : changes;
}

/**
 * Why a draft cannot be sent.
 *
 * Named rather than pre-worded, so the component owns the sentence and this
 * module stays free of copy. Both mirror a refusal the server would make
 * anyway; catching them here means the coordinator finds out while looking at
 * the field, and — for `name-taken` at festival scope — finds out *once*
 * rather than once per day of the fan-out.
 */
export type MissionProblem =
  | 'name-missing'
  | 'name-taken'
  | 'coordinates-invalid'
  | 'volunteers-invalid'
  | 'volunteers-order';

/**
 * `taken` is every mission key already in use, the mission being edited
 * included: its own key is skipped here rather than by the caller, because a
 * caller that forgot would make every card refuse to save itself.
 */
export function missionProblem(
  draft: MissionDraft,
  taken: readonly string[],
  ownKey: string | null = null,
): MissionProblem | null {
  const name = draft.name.trim();
  if (name === '') {
    return 'name-missing';
  }
  const key = missionKey(name);
  if (key !== ownKey && taken.includes(key)) {
    return 'name-taken';
  }
  if (
    draft.coordinates !== null &&
    draft.coordinates.trim() !== '' &&
    parseCoordinates(draft.coordinates) === null
  ) {
    return 'coordinates-invalid';
  }
  if (
    countInvalid(draft.minVolunteers, 0) ||
    countInvalid(draft.maxVolunteers, 1)
  ) {
    return 'volunteers-invalid';
  }
  // Only when both sides are one known number each. A side the days disagree
  // about (`null`) has no single value to compare against, and the server
  // checks every row against its own stored bound anyway.
  const min =
    draft.minVolunteers === null ? null : parseCount(draft.minVolunteers, 0);
  const max =
    draft.maxVolunteers === null ? null : parseCount(draft.maxVolunteers, 1);
  if (min !== null && max !== null && max < min) {
    return 'volunteers-order';
  }
  return null;
}

/** The body of a create, with the two optional fields omitted rather than sent
 * empty — see `api/useMissionWrites.ts`'s `NewMission`. */
export function newMissionInput(draft: MissionDraft): {
  readonly name: string;
  readonly description?: string;
  readonly address?: string;
  readonly exactAddress?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly minVolunteers?: number;
  readonly maxVolunteers?: number;
  readonly checkedByDefault?: boolean;
  readonly adultsOnly?: boolean;
} {
  const description =
    draft.description === null ? null : stated(draft.description);
  const address = draft.address === null ? null : stated(draft.address);
  const exactAddress =
    draft.exactAddress === null ? null : stated(draft.exactAddress);
  const coordinates =
    draft.coordinates === null ? null : parseCoordinates(draft.coordinates);
  const minVolunteers =
    draft.minVolunteers === null ? null : parseCount(draft.minVolunteers, 0);
  const maxVolunteers =
    draft.maxVolunteers === null ? null : parseCount(draft.maxVolunteers, 1);

  return {
    name: draft.name.trim(),
    ...(description === null ? {} : { description }),
    ...(address === null ? {} : { address }),
    ...(exactAddress === null ? {} : { exactAddress }),
    ...(coordinates === null
      ? {}
      : { latitude: coordinates.latitude, longitude: coordinates.longitude }),
    ...(minVolunteers === null ? {} : { minVolunteers }),
    ...(maxVolunteers === null ? {} : { maxVolunteers }),
    // Only a departure from the server's default is sent, like every other
    // optional key here: the body of an ordinary mission stays the body it was
    // before these existed.
    ...(draft.checkedByDefault === false ? { checkedByDefault: false } : {}),
    ...(draft.adultsOnly === true ? { adultsOnly: true } : {}),
  };
}

/** An empty card, for the "add a mission" form. */
export function emptyDraft(): NewMissionDraft {
  return {
    name: '',
    description: '',
    address: '',
    exactAddress: '',
    coordinates: '',
    minVolunteers: '',
    maxVolunteers: '',
    // The server's own defaults, so a coordinator who never looks at the boxes
    // creates the same mission the API would have without them.
    checkedByDefault: true,
    adultsOnly: false,
  };
}
