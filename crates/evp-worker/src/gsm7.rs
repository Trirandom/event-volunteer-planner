// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Ported, character for character, from
//! `docs/googleSheets/optimize-sms-text.js`. This is deliberately **not** an
//! attempt to improve on that script — French `à`/`å`/`É` are already
//! representable in GSM 03.38 and the original still transliterates them
//! away, because minimizing segment count mattered more to the spreadsheet
//! workflow than keeping every accent that technically fits. Faithfulness to
//! the behaviour that org already relies on is the point of this module; a
//! smarter septet-counting version is out of scope here (docs/17
//! §"Outbound", "GSM-7 is not a codec problem").

/// GSM 03.38's basic character set, verbatim from `send-sms.js`'s
/// `isGsm7Character` — including the literal `\n` and `\r`, which really are
/// members at those code positions.
const GSM7_BASIC: &str = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./\
                           0123456789:;<=>?\
                           ¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§\
                           ¿abcdefghijklmnopqrstuvwxyzäöñüà";

/// The extension table — escaped in real GSM-7 packing, two septets each, but
/// this module (like the script it ports) only decides keep-or-drop, not
/// segment cost.
const GSM7_EXTENDED: &str = "^{}\\[~]|€";

fn is_gsm7_char(ch: char) -> bool {
    GSM7_BASIC.contains(ch) || GSM7_EXTENDED.contains(ch)
}

/// The `replacements` table from `optimize-sms-text.js`. `None` means "not in
/// the table", not "delete this character" — that decision belongs to
/// [`is_gsm7_char`], applied afterwards.
fn replacement(ch: char) -> Option<&'static str> {
    Some(match ch {
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => "A",
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => "a",
        'Ç' => "C",
        'ç' => "c",
        'È' | 'É' | 'Ê' | 'Ë' => "E",
        'è' | 'é' | 'ê' | 'ë' => "e",
        'Ì' | 'Í' | 'Î' | 'Ï' => "I",
        'ì' | 'í' | 'î' | 'ï' => "i",
        'Ñ' => "N",
        'ñ' => "n",
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => "O",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => "o",
        'Ù' | 'Ú' | 'Û' | 'Ü' => "U",
        'ù' | 'ú' | 'û' | 'ü' => "u",
        'Ý' | 'Ÿ' => "Y",
        'ý' | 'ÿ' => "y",
        'Œ' => "OE",
        'œ' => "oe",
        'Æ' => "AE",
        'æ' => "ae",
        '\u{2019}' | '\u{2018}' => "'",
        '\u{201C}' | '\u{201D}' | '\u{201E}' => "\"",
        '\u{2013}' | '\u{2014}' | '\u{2212}' | '\u{2022}' | '\u{00B7}' => "-",
        '\u{2026}' => "...",
        '×' => "x",
        '÷' => "/",
        '©' => "(c)",
        '®' => "(R)",
        '™' => "(TM)",
        _ => return None,
    })
}

/// Transliterates, then drops whatever still is not GSM-7 — the same two
/// passes `optimizeSmsText` runs, in the same order (transliteration first,
/// so e.g. `œ` becomes `oe` rather than being dropped as non-GSM-7 outright).
#[must_use]
pub fn optimize(text: &str) -> String {
    let mut transliterated = String::with_capacity(text.len());
    for ch in text.chars() {
        match replacement(ch) {
            Some(replaced) => transliterated.push_str(replaced),
            None => transliterated.push(ch),
        }
    }
    transliterated
        .chars()
        .filter(|ch| is_gsm7_char(*ch))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::optimize;

    #[test]
    fn transliterates_french_accents() {
        assert_eq!(
            optimize("À bientôt, c'est décidé"),
            "A bientot, c'est decide"
        );
    }

    #[test]
    fn transliterates_ligatures_and_typography() {
        assert_eq!(optimize("Cœur — “ouvert”…"), "Coeur - \"ouvert\"...");
    }

    #[test]
    fn drops_characters_with_no_gsm7_representation_and_no_mapping() {
        // An emoji has no GSM-7 form and is not in the replacement table, so
        // it disappears rather than corrupting the rest of the message.
        assert_eq!(optimize("Merci 🎉 !"), "Merci  !");
    }

    #[test]
    fn native_gsm7_characters_pass_through_unchanged() {
        assert_eq!(optimize("Hello, World! 123"), "Hello, World! 123");
    }

    #[test]
    fn keeps_native_gsm7_extras_the_replacement_table_does_not_touch() {
        // '$' and '£' are in the GSM-7 basic set and never appear in the
        // replacement table, so both must survive untouched.
        assert_eq!(optimize("5$ ou 5£ ?"), "5$ ou 5£ ?");
    }
}
