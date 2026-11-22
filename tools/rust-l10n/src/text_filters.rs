//! text_filters.rs — общие фильтры пайплайна, порт
//! `.opencode/skills/pipeline-common/scripts/text_filters.mts` (1:1).
//!
//! Дублировать эти правила в других Rust-инструментах нельзя: единственный
//! владелец — TS-модуль, здесь его зеркало для POT-генератора (паритет
//! проверяется побайтовым сравнением выпущенного POT).
//!
//! Отличие от Python (унаследовано от TS): `isdigit` — только ASCII-цифры.

use rust_l10n_core::po::js_trim;

/// Префиксы «не переводится в принципе» (сырые ключи PlayMaker/пресетов).
const SKIP_RAW_PREFIXES: [&str; 12] = [
    "line_",
    "expressions/",
    "separatedexpressions/",
    "Poses/",
    "expressionadditive/",
    "p>xo",
    "Other Dialogue Presets",
    "Zoey Dialogue Presets",
    "_Preset",
    "Dialogue Presets",
    "Char_",
    "Apl_",
];

/// Спикеры, которых не считаем говорящими при разборе бандлов.
const KNOWN_NON_SPEAKERS: [&str; 7] = [
    "GlowingHole",
    "GlowingHoleKeys/",
    "Narrator",
    "Confirm",
    "Other Dialogue Presets",
    "Zoey Dialogue Presets",
    "Simon",
];

/// Есть ли строка в списке «известных не-спикеров».
pub fn is_known_non_speaker(s: &str) -> bool {
    KNOWN_NON_SPEAKERS.contains(&s)
}

/// Имя Unity-компонента/скрипта? (`NNHsvRenderer`, `EventSystem`, `NodeLink2`)
///
/// Правило «любая цифра = ассет» — только для строк без пробелов:
/// «Zone 2» останется текстом, «Zone2» уйдёт в skip.
pub fn is_asset_name(s: &str) -> bool {
    // JS `s.length` — UTF-16 units; для имён ассетов разницы нет, но контракт
    // переносим буквально.
    if s.is_empty() || s.contains(' ') || s.encode_utf16().count() < 4 {
        return false;
    }
    if s.starts_with("NN") || s.starts_with("AMS") {
        return true;
    }
    const ASSET_SUFFIXES: [&str; 12] = [
        "Renderer",
        "System",
        "Manager",
        "Controller",
        "Handler",
        "Receiver",
        "Target",
        "Pickup",
        "Link",
        "Mask",
        "Interact",
        "Effect",
    ];
    if ASSET_SUFFIXES.iter().any(|p| s.ends_with(p)) {
        return true;
    }
    if s.ends_with("UI") {
        return true;
    }
    s.bytes().any(|b| b.is_ascii_digit())
}

/// `[0-9]+\s?%$` (JS `\s`): цифры + необязательный пробел + `%` в конце.
fn pct_legit(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let Some(&last) = chars.last() else {
        return false;
    };
    if last != '%' {
        return false;
    }
    let mut i = chars.len() - 1;
    if i > 0 && rust_l10n_core::po::js_ws(chars[i - 1]) {
        i -= 1;
    }
    i > 0 && chars[i - 1].is_ascii_digit()
}

/// Бинарный мусор? (`Bff?D`, `H\?d`, `%IR`, `S5?d`)
///
/// Легитимный процент — цифры перед `%` в конце; легитимный `?` — в конце
/// строки или рядом с `!?.`.
pub fn is_garbage_fragment(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    if s.contains('\\') {
        return true;
    }
    if s.contains('%') && !pct_legit(s) {
        return true;
    }
    if s.contains('?') && !s.contains(' ') && !s.ends_with('?') && s.encode_utf16().count() <= 12 {
        // `?!`, `?...`, `??` легитимны; `?`, приклеенный к буквам/символам
        // (Bff?D, S5?d), — бинарный фрагмент.
        let chars: Vec<char> = s.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if *c == '?' && i + 1 < chars.len() && !"!?.".contains(chars[i + 1]) {
                return true;
            }
        }
    }
    false
}

/// Строка начинается с известного «не переводить» префикса.
pub fn is_skip_prefix(s: &str) -> bool {
    SKIP_RAW_PREFIXES.iter().any(|p| s.starts_with(p))
}

/// Убрать rich-теги (`/<[^>]+>/g`) и обрезать пробелы по краям (JS trim).
pub fn strip_rich(s: &str) -> String {
    js_trim(&strip_tags(s)).to_string()
}

/// Замена `/<[^>]+>/g` на пусто: `<` до ближайшего `>`, минимум один символ.
fn strip_tags(s: &str) -> String {
    if !s.contains('<') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            match bytes[i + 1..].iter().position(|&b| b == b'>') {
                Some(offset) if offset > 0 => {
                    i += 1 + offset + 1;
                    continue;
                }
                _ => {}
            }
        }
        // Копируем один UTF-8 символ целиком.
        let ch = s[i..].chars().next().expect("граница символа");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}
