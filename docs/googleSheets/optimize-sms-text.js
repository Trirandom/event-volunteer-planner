/**
 * Converts a message to the cheapest GSM-7 representation possible.
 *
 * The objective is to avoid Unicode SMS encoding and minimize
 * the number of SMS segments.
 */
function optimizeSmsText(text) {

  // Characters that can be safely replaced by simpler GSM characters.
  const replacements = {
    // French / Latin accents
    'À': 'A',
    'Á': 'A',
    'Â': 'A',
    'Ã': 'A',
    'Ä': 'A',
    'Å': 'A',

    'à': 'a',
    'á': 'a',
    'â': 'a',
    'ã': 'a',
    'ä': 'a',
    'å': 'a',

    'Ç': 'C',
    'ç': 'c',

    'È': 'E',
    'É': 'E',
    'Ê': 'E',
    'Ë': 'E',

    'è': 'e',
    'é': 'e',
    'ê': 'e',
    'ë': 'e',

    'Ì': 'I',
    'Í': 'I',
    'Î': 'I',
    'Ï': 'I',

    'ì': 'i',
    'í': 'i',
    'î': 'i',
    'ï': 'i',

    'Ñ': 'N',
    'ñ': 'n',

    'Ò': 'O',
    'Ó': 'O',
    'Ô': 'O',
    'Õ': 'O',
    'Ö': 'O',

    'ò': 'o',
    'ó': 'o',
    'ô': 'o',
    'õ': 'o',
    'ö': 'o',

    'Ù': 'U',
    'Ú': 'U',
    'Û': 'U',
    'Ü': 'U',

    'ù': 'u',
    'ú': 'u',
    'û': 'u',
    'ü': 'u',

    'Ý': 'Y',
    'Ÿ': 'Y',
    'ý': 'y',
    'ÿ': 'y',

    // Ligatures
    'Œ': 'OE',
    'œ': 'oe',
    'Æ': 'AE',
    'æ': 'ae',

    // Typography
    '’': "'",
    '‘': "'",
    '“': '"',
    '”': '"',
    '„': '"',

    '–': '-',
    '—': '-',
    '−': '-',

    '…': '...',

    // Other common symbols
    '•': '-',
    '·': '-',
    '×': 'x',
    '÷': '/',
    '©': '(c)',
    '®': '(R)',
    '™': '(TM)'
  };

  // Apply replacements
  let result = '';

  for (const char of text) {
    result += replacements[char] !== undefined
      ? replacements[char]
      : char;
  }

  // Remove characters that aren't GSM-7.
  // We do this LAST, after transliteration.
  result = removeNonGsmCharacters(result);

  return result;
}


/**
 * GSM 03.38 basic character set.
 */
function isGsm7Character(char) {

  const gsm7 =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
    'ÆæßÉ !\"#¤%&\'()*+,-./' +
    '0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
    '¿abcdefghijklmnopqrstuvwxyzäöñüà';

  const gsm7Extended =
    '^{}\\[~]|€';

  return (
    gsm7.includes(char) ||
    gsm7Extended.includes(char)
  );
}


/**
 * Removes characters that cannot be represented
 * using GSM-7.
 */
function removeNonGsmCharacters(text) {

  let result = '';

  for (const char of text) {

    if (isGsm7Character(char)) {
      result += char;
    } else {
      // If you prefer, replace unknown characters
      // with a space instead.
      result += '';
    }
  }

  return result;
}