// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The plain-text part of a schedule email: the message as a mail client
//! without HTML shows it. A port of `htmlToText` in the admin app, which
//! walks a `DOMParser` document.
//!
//! This is a tokenizer, not an HTML parser. It reads what coordinators write
//! in a template — paragraphs, line breaks, lists, bold, the odd `<div>` — and
//! agrees with the browser on that (the shared fixture checks it). It does not
//! try to agree on malformed markup, where the browser's error recovery is a
//! specification of its own; the HTML part is what such a template is read
//! in anyway.

/// Elements that start on their own line.
const BLOCKS: [&str; 13] = [
    "p", "div", "li", "ul", "ol", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6",
];

/// Elements whose content is not text anybody reads.
const SILENT: [&str; 4] = ["script", "style", "template", "title"];

struct Writer {
    out: String,
}

impl Writer {
    /// A block starts on its own line, but two nested blocks do not make an
    /// empty one between them — only `<br>` is a line break a person asked
    /// for.
    fn break_line(&mut self) {
        if !self.out.is_empty() && !self.out.ends_with('\n') {
            self.out.push('\n');
        }
    }

    /// A paragraph is set off by a blank line, as a mail client's margins set
    /// it off on screen. The rich-text editor writes nothing else between
    /// paragraphs (ADR-0046), so without this they would run together. One
    /// at the very start is trimmed with the rest.
    fn blank_line(&mut self) {
        self.break_line();
        if !self.out.ends_with("\n\n") {
            self.out.push('\n');
        }
    }

    /// Source whitespace is layout in HTML, not text: each run becomes one
    /// space, as JavaScript's `/\s+/g` does.
    fn text(&mut self, raw: &str) {
        let decoded = decode_entities(raw);
        let mut in_space = false;
        for c in decoded.chars() {
            if c.is_whitespace() {
                if !in_space {
                    self.out.push(' ');
                }
                in_space = true;
            } else {
                self.out.push(c);
                in_space = false;
            }
        }
    }
}

/// A tag's name, lower-cased, and whether it closes. `None` when the `<` does
/// not start a tag, in which case it is text, as in HTML.
fn tag_name(tag: &str) -> Option<(String, bool)> {
    let (closing, rest) = match tag.strip_prefix('/') {
        Some(rest) => (true, rest),
        None => (false, tag),
    };
    let name: String = rest
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let starts_with_letter = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    starts_with_letter.then_some((name, closing))
}

/// The message's text.
#[must_use]
pub fn html_to_text(html: &str) -> String {
    let mut writer = Writer { out: String::new() };
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        writer.text(rest.get(..open).unwrap_or_default());
        let after = rest.get(open.saturating_add(1)..).unwrap_or_default();

        if let Some(comment) = after.strip_prefix("!--") {
            rest = comment
                .find("-->")
                .and_then(|end| comment.get(end.saturating_add(3)..))
                .unwrap_or_default();
            continue;
        }
        let Some(close) = after.find('>') else {
            // An unclosed `<` is text to the end.
            writer.text(rest.get(open..).unwrap_or_default());
            rest = "";
            break;
        };
        let inside = after.get(..close).unwrap_or_default();
        let next = after.get(close.saturating_add(1)..).unwrap_or_default();
        let Some((name, closing)) = tag_name(inside) else {
            if inside.starts_with('!') || inside.starts_with('?') {
                // A doctype or processing instruction: nothing to read.
                rest = next;
            } else {
                writer.text("<");
                rest = after;
            }
            continue;
        };
        rest = next;

        if !closing && SILENT.contains(&name.as_str()) {
            // Skip to the matching close tag, whatever is inside.
            let lower = rest.to_ascii_lowercase();
            let end_tag = format!("</{name}");
            rest = lower
                .find(&end_tag)
                .and_then(|at| rest.get(at..))
                .and_then(|tail| {
                    tail.find('>')
                        .and_then(|gt| tail.get(gt.saturating_add(1)..))
                })
                .unwrap_or_default();
            continue;
        }
        if name == "br" {
            if !closing {
                writer.out.push('\n');
            }
            continue;
        }
        if name == "p" {
            writer.blank_line();
        } else if BLOCKS.contains(&name.as_str()) {
            writer.break_line();
            if name == "li" && !closing {
                writer.out.push_str("• ");
            }
        }
    }
    writer.text(rest);

    let lines: Vec<&str> = writer.out.split('\n').map(str::trim).collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_owned()
}

/// The entities a template or an escaped value can contain: the five the
/// renderer writes, `&nbsp;`, and numeric references. Anything else is left
/// as written — a bare `&` in a template is text.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(rest.get(..amp).unwrap_or_default());
        let after = rest.get(amp.saturating_add(1)..).unwrap_or_default();
        let decoded = after.find(';').and_then(|semi| {
            let entity = after.get(..semi)?;
            let c = match entity {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                "nbsp" => '\u{a0}',
                numeric => {
                    let digits = numeric.strip_prefix('#')?;
                    let code = match digits.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => digits.parse::<u32>().ok()?,
                    };
                    char::from_u32(code)?
                }
            };
            Some((c, semi))
        });
        if let Some((c, semi)) = decoded {
            out.push(c);
            rest = after.get(semi.saturating_add(1)..).unwrap_or_default();
        } else {
            out.push('&');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::html_to_text;

    #[test]
    fn line_breaks_paragraphs_and_lists() {
        assert_eq!(
            html_to_text(
                "<div>Bonjour Camille,<br><br>Voici :<ul><li>Bar</li><li>Gate</li></ul>À bientôt</div>"
            ),
            "Bonjour Camille,\n\nVoici :\n• Bar\n• Gate\nÀ bientôt"
        );
    }

    #[test]
    fn source_whitespace_is_not_text() {
        assert_eq!(
            html_to_text("<p>\n  Bonjour\n   Camille  </p>\n\n<p>Merci</p>"),
            // The whitespace between the paragraphs is a text node of its own,
            // so the second block starts after a space, not after a newline —
            // one blank line, as in the browser.
            "Bonjour Camille\n\nMerci"
        );
    }

    #[test]
    fn entities_are_decoded_once() {
        assert_eq!(
            html_to_text("Bar &amp; Snack &lt;b&gt; &#39;x&#x27; &amp;amp; a&nbsp;b &copy; & ;"),
            "Bar & Snack <b> 'x' &amp; a b &copy; & ;"
        );
    }

    #[test]
    fn three_breaks_collapse_to_one_blank_line() {
        assert_eq!(html_to_text("a<br><br><br><br>b"), "a\n\nb");
    }

    #[test]
    fn silent_elements_comments_and_doctypes_say_nothing() {
        assert_eq!(
            html_to_text(
                "<!doctype html><style>p{color:red}</style><!-- note --><p>Hi</p><SCRIPT>alert(1)</SCRIPT>"
            ),
            "Hi"
        );
    }

    #[test]
    fn inline_tags_and_attributes_vanish() {
        assert_eq!(
            html_to_text("<div dir=\"ltr\"><b>L’équipe</b> <a href=\"x\">Asso</a></div>"),
            "L’équipe Asso"
        );
    }

    #[test]
    fn a_lone_angle_bracket_is_text() {
        assert_eq!(html_to_text("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
        assert_eq!(html_to_text("a <"), "a <");
    }
}
