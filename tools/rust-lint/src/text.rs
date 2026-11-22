//! text.rs — независимые проверки текста: невидимки, алфавиты, мохибейк,
//! TMP-теги, числа, плейсхолдеры.
//!
//! Всё здесь — чистые функции над строкой: их можно тестировать без файлов и
//! переиспользовать в отчёте. Ни одна функция ничего не правит.

use std::collections::BTreeMap;

use rust_l10n_core::po::js_ws;

// ── Нормализация ─────────────────────────────────────────────────────────

/// Схлопнуть пробелы (JS-набор: NBSP/BOM тоже пробелы) и обрезать края.
pub fn normalize_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.trim_matches(js_ws).chars() {
        if js_ws(c) {
            in_ws = true;
            continue;
        }
        if in_ws && !out.is_empty() {
            out.push(' ');
        }
        in_ws = false;
        out.push(c);
    }
    out
}

/// Виды невидимых символов. `None` — обычный символ.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Invisible {
    Nbsp,
    ZeroWidth,
    Bom,
    Bidi,
    SoftHyphen,
}

impl Invisible {
    pub fn label(self) -> &'static str {
        match self {
            Invisible::Nbsp => "NBSP",
            Invisible::ZeroWidth => "zero-width",
            Invisible::Bom => "BOM",
            Invisible::Bidi => "bidi",
            Invisible::SoftHyphen => "soft-hyphen",
        }
    }
}

/// Классифицировать невидимый символ.
pub fn invisible_kind(c: char) -> Option<Invisible> {
    match c {
        '\u{00a0}' => Some(Invisible::Nbsp),
        '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{180e}' => {
            Some(Invisible::ZeroWidth)
        }
        '\u{feff}' => Some(Invisible::Bom),
        '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => {
            Some(Invisible::Bidi)
        }
        '\u{00ad}' => Some(Invisible::SoftHyphen),
        _ => None,
    }
}

/// Убрать все невидимые символы (для нормализации ключа).
pub fn strip_invisible(s: &str) -> String {
    s.chars().filter(|c| invisible_kind(*c).is_none()).collect()
}

/// Найденные невидимые символы: `(символ, вид, сколько раз)`.
pub fn invisibles(s: &str) -> Vec<(char, Invisible, usize)> {
    let mut order: Vec<(char, Invisible)> = Vec::new();
    let mut counts: BTreeMap<(char, Invisible), usize> = BTreeMap::new();
    for c in s.chars() {
        if let Some(kind) = invisible_kind(c) {
            let key = (c, kind);
            if !counts.contains_key(&key) {
                order.push(key);
            }
            *counts.entry(key).or_insert(0) += 1;
        }
    }
    order
        .into_iter()
        .map(|(c, kind)| (c, kind, counts[&(c, kind)]))
        .collect()
}

/// Есть ли буквы (для «нелингвистический текст»).
pub fn has_letters(s: &str) -> bool {
    s.chars().any(char::is_alphabetic)
}

/// Похоже ли на человеческий текст, а не на бинарный/технический фрагмент.
///
/// Порог: ≥2 буквы, хотя бы одна гласная, буквы составляют не меньше половины
/// видимых символов. Нужен, чтобы `" & 9 D t`, `!!Y-, E` и `KQXED` не давали
/// находок про числа и бэкслэши.
pub fn looks_linguistic(s: &str) -> bool {
    let vowels = "aeiouyAEIOUYаеёиоуыэюяАЕЁИОУЫЭЮЯ";
    let letters = s.chars().filter(|c| c.is_alphabetic()).count();
    let vowel_count = s
        .chars()
        .filter(|c| c.is_alphabetic() && vowels.contains(*c))
        .count();
    if letters < 3 || vowel_count * 4 < letters {
        return false;
    }
    let visible = s.chars().filter(|c| !c.is_whitespace()).count();
    letters * 2 >= visible
}

/// Похоже ли на фразу (а не имя/метку/символ): ≥2 слов с буквами, есть строчные.
pub fn looks_sentence_like(s: &str) -> bool {
    let wordy = s
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphabetic))
        .count();
    wordy >= 2 && s.chars().any(|c| c.is_alphabetic() && c.is_lowercase()) && looks_linguistic(s)
}

// ── Алфавиты ─────────────────────────────────────────────────────────────

fn is_cyrillic(c: char) -> bool {
    matches!(c,
        '\u{0400}'..='\u{052f}'
        | '\u{2de0}'..='\u{2dff}'
        | '\u{a640}'..='\u{a69f}'
        | '\u{1c80}'..='\u{1c88}')
}

fn is_latin(c: char) -> bool {
    c.is_ascii_alphabetic()
        || matches!(c,
            '\u{00c0}'..='\u{024f}'
            | '\u{1e00}'..='\u{1eff}'
            | '\u{2c60}'..='\u{2c7f}'
            | '\u{a720}'..='\u{a7ff}'
            | '\u{ab30}'..='\u{ab6f}')
}

/// Слова, где латиница и кириллица смешаны внутри одного токена.
pub fn mixed_alpha_tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut token = String::new();
    let push = |token: &mut String, out: &mut Vec<String>| {
        if token.is_empty() {
            return;
        }
        let cyr = token.chars().any(is_cyrillic);
        let lat = token.chars().any(is_latin);
        if cyr && lat {
            out.push(token.clone());
        }
        token.clear();
    };
    for c in s.chars() {
        if c.is_alphanumeric() || c == '_' {
            token.push(c);
        } else {
            push(&mut token, &mut out);
        }
    }
    push(&mut token, &mut out);
    out
}

// ── Мохибейк ─────────────────────────────────────────────────────────────

fn is_mojibake_char(c: char) -> bool {
    matches!(c,
        '\u{00d0}' | '\u{00d1}' | '\u{00c2}' | '\u{00c3}'
        | '\u{00b5}' | '\u{00b0}' | '\u{201a}' | '\u{20ac}'
        | '\u{0402}' | '\u{0403}' | '\u{0405}' | '\u{0408}'..='\u{040f}'
        | '\u{0452}' | '\u{0453}' | '\u{0455}' | '\u{0458}'..='\u{045f}')
}

/// Признаки «UTF-8 прочитан как cp1251/cp866». Порог: U+FFFD сразу,
/// иначе ≥2 подозрительных символа (один `Ã` бывает и в живом тексте).
pub fn mojibake_evidence(s: &str) -> Vec<String> {
    if s.contains('\u{fffd}') {
        return vec!["U+FFFD (replacement char)".to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    for c in s.chars() {
        if is_mojibake_char(c) {
            let label = format!("U+{:04X} ({c})", c as u32);
            if !out.contains(&label) {
                out.push(label);
            }
        }
    }
    let suspicious = s.chars().filter(|c| is_mojibake_char(*c)).count();
    if suspicious < 2 {
        return Vec::new();
    }
    out.truncate(8);
    out
}

// ── Типографика ──────────────────────────────────────────────────────────

/// Кудрявые апострофы/кавычки вплотную к латинским буквам.
pub fn typographic_latin(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        let prev = i.checked_sub(1).and_then(|p| chars.get(p)).copied();
        let next = chars.get(i + 1).copied();
        let near_latin = prev.is_some_and(is_latin) || next.is_some_and(is_latin);
        let apostrophe = matches!(c, '\u{2018}' | '\u{2019}' | '\u{02bc}');
        let quote = matches!(c, '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}');
        if (apostrophe && prev.is_some_and(is_latin) && next.is_some_and(is_latin))
            || (quote && near_latin)
        {
            let label = format!("U+{:04X} ({c})", *c as u32);
            if !out.contains(&label) {
                out.push(label);
            }
        }
    }
    out
}

// ── Экранирование ────────────────────────────────────────────────────────

/// Литеральные `\n`, `\t`, `\r`, `\"` в уже разобранном значении.
pub fn double_escape_markers(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if *c != '\\' {
            continue;
        }
        if let Some(next) = chars.get(i + 1) {
            if matches!(next, 'n' | 'r' | 't' | '"') {
                let marker = format!("\\{next}");
                if !out.contains(&marker) {
                    out.push(marker);
                }
            }
        }
    }
    out
}

/// Сколько обратных слэшей в значении.
pub fn backslash_count(s: &str) -> usize {
    s.chars().filter(|c| *c == '\\').count()
}

// ── TMP-теги ─────────────────────────────────────────────────────────────

/// Разобранный тег: имя без атрибутов, признак закрытия и исходный вид.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    pub name: String,
    pub closing: bool,
    pub raw: String,
}

/// Теги, которые обязаны парно закрываться.
const PAIR_TAGS: &[&str] = &[
    "b", "i", "u", "s", "color", "size", "mark", "sup", "sub", "link", "noparse",
];

/// `<font>` / `<material>` выбирает рантайм — в сравнении и балансе не участвуют.
pub fn is_render_owned(name: &str) -> bool {
    matches!(name, "font" | "material")
}

/// Разобрать теги `<name ...>` / `</name>`. Псевдотеги вроде `<< 5` и `a < b`
/// не считаются: после `<` (и `/`) обязана идти ASCII-буква.
pub fn parse_tags(s: &str) -> Vec<Tag> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '<' {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i + 1;
        let closing = chars.get(j) == Some(&'/');
        if closing {
            j += 1;
        }
        if !chars.get(j).is_some_and(|c| c.is_ascii_alphabetic()) {
            i += 1;
            continue;
        }
        let name_start = j;
        while chars
            .get(j)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        {
            j += 1;
        }
        let name: String = chars[name_start..j]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        while j < chars.len() && chars[j] != '>' {
            j += 1;
        }
        if j >= chars.len() {
            break;
        }
        let raw: String = chars[start..=j].iter().collect();
        out.push(Tag { name, closing, raw });
        i = j + 1;
    }
    out
}

/// Проблемы баланса/вложенности одного текста.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TagIssues {
    /// Лишнее закрытие или закрытие без открытия — почти всегда ошибка.
    pub balance: Vec<String>,
    /// Тег остался открытым до конца строки (TMP закрывает его неявно).
    pub unclosed: Vec<String>,
    pub nesting: Vec<String>,
}

impl TagIssues {
    pub fn is_clean(&self) -> bool {
        self.balance.is_empty() && self.unclosed.is_empty() && self.nesting.is_empty()
    }
}

/// Проверить баланс и порядок закрытия парных тегов.
pub fn tag_issues(s: &str) -> TagIssues {
    let mut issues = TagIssues::default();
    let mut stack: Vec<String> = Vec::new();
    for tag in parse_tags(s) {
        if !PAIR_TAGS.contains(&tag.name.as_str()) {
            continue;
        }
        if !tag.closing {
            stack.push(tag.name);
            continue;
        }
        match stack.last() {
            Some(top) if *top == tag.name => {
                stack.pop();
            }
            Some(top) => {
                if let Some(pos) = stack.iter().rposition(|n| *n == tag.name) {
                    issues
                        .nesting
                        .push(format!("</{}> закрыт раньше, чем <{}>", tag.name, top));
                    stack.truncate(pos);
                } else {
                    issues
                        .balance
                        .push(format!("лишнее закрытие </{}>", tag.name));
                }
            }
            None => issues
                .balance
                .push(format!("лишнее закрытие </{}>", tag.name)),
        }
    }
    for name in stack {
        issues.unclosed.push(format!("не закрыт <{name}>"));
    }
    issues
}

/// Счётчик ОТКРЫВАЮЩИХ тегов по имени (font/material исключены).
pub fn tag_counts(s: &str) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for tag in parse_tags(s) {
        if tag.closing || is_render_owned(&tag.name) {
            continue;
        }
        *out.entry(tag.name).or_insert(0) += 1;
    }
    out
}

/// Расхождения набора тегов: (потеряно, лишнее) как «имя×N».
pub fn tag_presence_diff(original: &str, translation: &str) -> (Vec<String>, Vec<String>) {
    let a = tag_counts(original);
    let b = tag_counts(translation);
    let mut missing = Vec::new();
    let mut extra = Vec::new();
    for (name, n) in &a {
        let m = b.get(name).copied().unwrap_or(0);
        if *n > m {
            missing.push(format!("{name}×{}", n - m));
        }
    }
    for (name, n) in &b {
        let m = a.get(name).copied().unwrap_or(0);
        if *n > m {
            extra.push(format!("{name}×{}", n - m));
        }
    }
    (missing, extra)
}

// ── Числа и плейсхолдеры ─────────────────────────────────────────────────

/// Последовательность цифровых прогонов (полноширинные цифры → ASCII).
pub fn numeric_runs(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        let digit = match c {
            '0'..='9' => Some(c),
            '\u{ff10}'..='\u{ff19}' => char::from_u32(c as u32 - 0xff10 + u32::from(b'0')),
            _ => None,
        };
        match digit {
            Some(d) => cur.push(d),
            None => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Номера строк вида `132-`, `66-…`: цифры 2–4 знака перед дефисом.
pub fn line_ids(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        let len = i - start;
        let boundary = start == 0 || !chars[start - 1].is_alphanumeric();
        let dash = chars
            .get(i)
            .is_some_and(|c| matches!(c, '-' | '\u{2013}' | '\u{2014}'));
        let after_dash = chars.get(i + 1).is_some_and(|c| !c.is_ascii_digit());
        if boundary && (2..=4).contains(&len) && dash && after_dash {
            out.push(chars[start..i].iter().collect());
        }
    }
    out
}

/// Плейсхолдеры: `{0}`, `{name}`, `%s`, `%1$s`, `%%`, `[name]`.
pub fn placeholders(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '{' => {
                if let Some(end) = find_close(&chars, i + 1, '}', 40) {
                    let content: String = chars[i + 1..end].iter().collect();
                    if !content.is_empty() && !content.contains('{') && !content.contains('}') {
                        out.push(format!("{{{content}}}"));
                    }
                    i = end + 1;
                } else {
                    i += 1;
                }
            }
            '[' => {
                let prev_bracket = i > 0 && chars[i - 1] == '[';
                if !prev_bracket {
                    if let Some(end) = find_close(&chars, i + 1, ']', 24) {
                        let content: String = chars[i + 1..end].iter().collect();
                        if !content.is_empty()
                            && content
                                .chars()
                                .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
                        {
                            out.push(format!("[{content}]"));
                        }
                        i = end + 1;
                        continue;
                    }
                }
                i += 1;
            }
            '%' => {
                if chars.get(i + 1) == Some(&'%') {
                    out.push("%%".to_string());
                    i += 2;
                    continue;
                }
                let mut j = i + 1;
                while chars.get(j).is_some_and(|c| c.is_ascii_digit()) {
                    j += 1;
                }
                if chars.get(j) == Some(&'$') {
                    j += 1;
                }
                while chars
                    .get(j)
                    .is_some_and(|c| matches!(c, '-' | '+' | ' ' | '0' | '#'))
                {
                    j += 1;
                }
                while chars.get(j).is_some_and(|c| c.is_ascii_digit()) {
                    j += 1;
                }
                if chars.get(j) == Some(&'.') {
                    j += 1;
                    while chars.get(j).is_some_and(|c| c.is_ascii_digit()) {
                        j += 1;
                    }
                }
                match chars.get(j) {
                    Some(c) if "sdifuxXegEGaAoc".contains(*c) => {
                        out.push(chars[i..=j].iter().collect());
                        i = j + 1;
                    }
                    _ => i += 1,
                }
            }
            _ => i += 1,
        }
    }
    out
}

fn find_close(chars: &[char], from: usize, close: char, limit: usize) -> Option<usize> {
    let end = (from + limit).min(chars.len());
    (from..end).find(|i| chars[*i] == close)
}

/// Терминальная пунктуация конца предложения.
pub fn ends_sentence(s: &str) -> bool {
    let trimmed = s.trim_end();
    trimmed.chars().last().is_some_and(|c| {
        matches!(
            c,
            '.' | '!' | '?' | '\u{2026}' | '\u{3002}' | '\u{ff01}' | '\u{ff1f}'
        )
    })
}

/// Заканчивается ли строка буквой/цифрой (без учёта хвостовых пробелов).
pub fn ends_with_word_char(s: &str) -> bool {
    s.trim_end()
        .chars()
        .last()
        .is_some_and(|c| c.is_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invisible_detection() {
        let s = "a\u{00a0}b\u{200b}c\u{feff}d\u{202e}e";
        assert_eq!(invisibles(s).len(), 4);
        assert_eq!(strip_invisible(s), "abcde");
    }

    #[test]
    fn mixed_alpha() {
        assert_eq!(mixed_alpha_tokens("Это cлово"), vec!["cлово".to_string()]);
        assert!(mixed_alpha_tokens("normal English text").is_empty());
        assert!(mixed_alpha_tokens("Русский текст").is_empty());
    }

    #[test]
    fn mojibake_threshold() {
        assert!(mojibake_evidence("Ão").is_empty());
        assert!(!mojibake_evidence("ÐŸÑ€Ð¸Ð²ÐµÑ‚").is_empty());
        assert!(!mojibake_evidence("bad\u{fffd}char").is_empty());
    }

    #[test]
    fn typographic_only_near_latin() {
        assert!(!typographic_latin("don\u{2019}t").is_empty());
        assert!(typographic_latin("«Привет»").is_empty());
        assert!(typographic_latin("l’amour").len() == 1);
    }

    #[test]
    fn tags_ignore_font_and_material() {
        let s = "<font=\"X\"><i>Hi</i></font>";
        assert!(tag_issues(s).is_clean());
        assert_eq!(tag_counts(s).get("i"), Some(&1));
        assert_eq!(tag_counts(s).get("font"), None);
    }

    #[test]
    fn tag_balance_and_nesting() {
        assert!(!tag_issues("<b>open").unclosed.is_empty());
        assert!(!tag_issues("</b>").balance.is_empty());
        assert!(!tag_issues("<b><i>x</b></i>").nesting.is_empty());
        assert!(tag_issues("<b><i>x</i></b>").is_clean());
        assert!(tag_issues("a < b and c > d").is_clean());
    }

    #[test]
    fn placeholders_extraction() {
        assert_eq!(
            placeholders("Hi {0}, %s and [name], 100%%"),
            vec!["{0}", "%s", "[name]", "%%"]
        );
        assert_eq!(placeholders("%1$s"), vec!["%1$s"]);
        assert!(placeholders("[[nested]]").is_empty());
    }

    #[test]
    fn linguistic_gate() {
        assert!(looks_linguistic("The K9 is blocking the way."));
        assert!(looks_linguistic("01-Staring Are we 0"));
        assert!(!looks_linguistic("!!Y-, E"));
        assert!(!looks_linguistic(" & 9 D t"));
        assert!(!looks_linguistic("KQXED"));
        assert!(looks_sentence_like("New Game"));
        assert!(!looks_sentence_like("Back"));
        assert!(!looks_sentence_like("!!Y-, E"));
    }

    #[test]
    fn line_ids_extraction() {
        assert_eq!(line_ids("66-Your loss 1"), vec!["66"]);
        assert!(line_ids("2026-11-22").is_empty());
    }
}
