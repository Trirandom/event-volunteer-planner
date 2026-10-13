// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Design primitives and the few things both applications genuinely share.
 *
 * What does *not* belong here: anything that would drag the coordinator
 * application's dependencies into `apps/form`. The split is a security
 * boundary before it is a size optimisation (docs/09 §6), and a shared package
 * is the obvious place for it to leak.
 */

export { default as BrandMark } from './components/BrandMark.vue';
export { default as LocaleSwitcher } from './components/LocaleSwitcher.vue';
export { default as SourceNotice } from './components/SourceNotice.vue';
export { fetchMeta, metaSchema, type Meta, type MetaResult } from './meta.js';
export { useMeta, type MetaState } from './useMeta.js';
export {
  brand,
  brandFamilies,
  brandSteps,
  brandVariableName,
  type BrandFamily,
  type BrandRamp,
  type BrandStep,
} from './brand.js';
export {
  contrastRequirements,
  cssVariableName,
  palettes,
  type ContrastRequirement,
  type Palette,
  type ThemeName,
} from './tokens.js';
export {
  eventColor,
  eventColorChoiceCount,
  eventColorChoices,
  eventColorCount,
  eventColors,
} from './eventColors.js';
export {
  AA_BODY_TEXT,
  AA_LARGE_TEXT_AND_UI,
  contrastRatio,
  parseHex,
  relativeLuminance,
  type Rgb,
} from './contrast.js';
