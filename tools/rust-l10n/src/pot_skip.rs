//! pot_skip.rs — логика «этой строке перевод не нужен» (1:1 с TS-эталоном
//! `.opencode/skills/extract-text/scripts/pot_skip.mts`).
//!
//! Три вещи и только они:
//! - [`strip_tmp_tags`] — чистка TMP-разметки по СПИСКУ тегов [`TMP_TAGS`];
//! - [`classify_rich`] — обрывок/расхождение/норма для пары `(msgid, rich_text)`;
//! - [`skip_condition_matches`] — условия правил skip-политики.
//!
//! Почему чистка по списку, а не `<[^>]+>`: в данных игры `<` и `>` работают
//! авторскими кавычками («< Like this, … request them. >»). Регекс «любой
//! `<...>`» съедает кусок от такой кавычки до реального тега, и дефект
//! маскируется (наивная чистка даёт 0 обрывков там, где они есть). Поэтому
//! снимаются ТОЛЬКО известные TMP-теги; остальное остаётся текстом.
//!
//! Паритет TS ↔ Rust стерегут `scripts/text_parity.test.mts` и
//! `.opencode/skills/extract-text/tests/potgen.test.mts`.

use rust_l10n_core::po::js_ws;

use crate::inventory::py_strip;

/// Известные TMP-теги (Rich Text Mesh Pro); закрывающий вариант — `</имя>`.
///
/// Список — данные: новый тег добавляется одной строкой здесь и в
/// `pot_skip.mts`. `s` — зачёркивание, теги с параметром (`size=`, `color=`…)
/// и без (`br`, `page`, `nobr`, `noparse`).
pub const TMP_TAGS: [&str; 25] = [
    "i",
    "b",
    "u",
    "s",
    "size",
    "color",
    "alpha",
    "material",
    "link",
    "sprite",
    "pos",
    "align",
    "cspace",
    "indent",
    "line-height",
    "mspace",
    "space",
    "voffset",
    "width",
    "font",
    "mark",
    "nobr",
    "noparse",
    "page",
    "br",
];

/// Конец TMP-тега в `start` (индекс `<`), если это известный тег.
///
/// Грамматика (как у регекса TS): `<`, необязательный `/`, имя из
/// [`TMP_TAGS`] (регистронезависимо), граница имени (пробел/`=`/`/`/`>`),
/// затем параметры до `>`; `<` внутри параметров запрещён (`[^<>]*>`).
fn tmp_tag_end(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = start + 1;
    if bytes.get(i) == Some(&b'/') {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    if i == name_start {
        return None;
    }
    let name = &s[name_start..i];
    let next = s[i..].chars().next()?;
    if !(js_ws(next) || next == '=' || next == '/' || next == '>') {
        return None;
    }
    if !TMP_TAGS.iter().any(|tag| tag.eq_ignore_ascii_case(name)) {
        return None;
    }
    let mut j = i;
    while j < bytes.len() {
        match bytes[j] {
            b'>' => return Some(j + 1),
            b'<' => return None,
            _ => j += 1,
        }
    }
    None
}

/// Убрать ТОЛЬКО известные TMP-теги; прочие `<...>` — авторский текст.
pub fn strip_tmp_tags(s: &str) -> String {
    if !s.contains('<') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(end) = tmp_tag_end(s, i) {
                i = end;
                continue;
            }
        }
        let ch = s[i..].chars().next().expect("граница символа");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Порог «осмысленного» обрывка: короче брать нельзя.
///
/// Замер 2026-11-23 (`tmp/dump-after`): хвостов `text` в `rich_text` семь, но
/// пять из них — один символ `">"` (шум шрифтовой разметки, не фраза). Чтобы
/// инвариант не утонул в ложных, обрывком считается ключ не короче 10 символов
/// и не менее чем из двух слов.
pub const FRAGMENT_MIN_CHARS: usize = 10;
pub const FRAGMENT_MIN_WORDS: usize = 2;

/// Максимальная длина «короткого токена» в code points.
pub const SHORT_TOKEN_MAX_CHARS: usize = 12;

/// Длина в code points (Python `len`, не UTF-16 units).
fn cp_len(s: &str) -> usize {
    s.chars().count()
}

/// Осмысленный ли ключ для диагноза «обрывок» (см. [`FRAGMENT_MIN_CHARS`]).
pub fn is_meaningful_text(s: &str) -> bool {
    let text = py_strip(s);
    if cp_len(text) < FRAGMENT_MIN_CHARS {
        return false;
    }
    text.split_whitespace().filter(|w| !w.is_empty()).count() >= FRAGMENT_MIN_WORDS
}

/// Отношение `msgid` к `rich_text` (см. однозначные имена в TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RichRelation {
    Ok,
    Suffix,
    Mismatch,
    Noise,
}

impl RichRelation {
    pub fn as_str(self) -> &'static str {
        match self {
            RichRelation::Ok => "ok",
            RichRelation::Suffix => "suffix",
            RichRelation::Mismatch => "mismatch",
            RichRelation::Noise => "noise",
        }
    }
}

/// Результат [`classify_rich`]: отношение + полный текст без тегов.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RichCheck {
    pub relation: RichRelation,
    /// `rich_text` без TMP-тегов, обрезанный по краям.
    pub plain: String,
}

/// Сравнить ключ с полным текстом `rich_text`. Единственная реализация.
pub fn classify_rich(msgid: &str, rich: &str) -> RichCheck {
    let plain = py_strip(&strip_tmp_tags(rich)).to_string();
    let id = py_strip(msgid);
    if plain == id {
        return RichCheck {
            relation: RichRelation::Ok,
            plain,
        };
    }
    if !is_meaningful_text(id) {
        return RichCheck {
            relation: RichRelation::Noise,
            plain,
        };
    }
    let relation = if plain.ends_with(id) {
        RichRelation::Suffix
    } else {
        RichRelation::Mismatch
    };
    RichCheck { relation, plain }
}

/// Условия правил skip-политики (имена — контракт JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipCondition {
    NoLetters,
    ShortToken,
    NoWord,
    Identifier,
    Tokens,
    HexColor,
    AssetPath,
    Fragment,
}

impl SkipCondition {
    /// Разбор значения `when` из JSON (`None` — неизвестное условие).
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "noLetters" => Some(SkipCondition::NoLetters),
            "shortToken" => Some(SkipCondition::ShortToken),
            "noWord" => Some(SkipCondition::NoWord),
            "identifier" => Some(SkipCondition::Identifier),
            "tokens" => Some(SkipCondition::Tokens),
            "hexColor" => Some(SkipCondition::HexColor),
            "assetPath" => Some(SkipCondition::AssetPath),
            "fragment" => Some(SkipCondition::Fragment),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SkipCondition::NoLetters => "noLetters",
            SkipCondition::ShortToken => "shortToken",
            SkipCondition::NoWord => "noWord",
            SkipCondition::Identifier => "identifier",
            SkipCondition::Tokens => "tokens",
            SkipCondition::HexColor => "hexColor",
            SkipCondition::AssetPath => "assetPath",
            SkipCondition::Fragment => "fragment",
        }
    }
}

/// Приближение категорий M* (комбинирующие знаки), которых нет в JS `\p{L}`.
fn is_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036f}' | '\u{0483}'..='\u{0489}' | '\u{0591}'..='\u{05bd}'
        | '\u{0610}'..='\u{061a}' | '\u{064b}'..='\u{065f}' | '\u{1ab0}'..='\u{1aff}'
        | '\u{1dc0}'..='\u{1dff}' | '\u{20d0}'..='\u{20f0}' | '\u{fe20}'..='\u{fe2f}')
}

/// Есть ли в строке хоть одна буква (JS `\p{L}`: Alphabetic без M*).
pub fn has_letters(s: &str) -> bool {
    s.chars().any(is_letter)
}

/// Буква по правилу TS `\p{L}`: Alphabetic без комбинирующих знаков.
fn is_letter(c: char) -> bool {
    c.is_alphabetic() && !is_combining_mark(c)
}

/// Символ внутри токена: буква или цифра (TS `[\p{L}\p{N}]`).
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// Сколько букв должно быть в токене, чтобы он считался словом.
pub const WORD_MIN_LETTERS: usize = 3;

/// Есть ли в строке хотя бы одно «слово» — токен из ≥3 букв.
///
/// Токен — максимальный отрезок букв/цифр; цифры в нём разрешены, но считаются
/// только буквы (как в TS-эталоне). На `raw:*` совпадает с 3 138 записями:
/// 2 961 — токены без пробелов (их уже закрывает `shortToken`), 177 — шум с
/// пробелом (`wK Ax`, `j A`, `w? |b`). Настоящие подписи (`ACCESS`,
/// `SAVEFILENAME`) не трогает: у них есть слово.
pub fn has_word(text: &str) -> bool {
    let mut letters = 0usize;
    for c in text.chars() {
        if is_word_char(c) {
            if is_letter(c) {
                letters += 1;
            }
            continue;
        }
        if letters >= WORD_MIN_LETTERS {
            return true;
        }
        letters = 0;
    }
    letters >= WORD_MIN_LETTERS
}

/// Похоже ли на программный идентификатор, а не на текст (1:1 с TS).
///
/// Структурный признак, а не «по виду»: CamelCase из ≥2 горбов (не ALLCAPS)
/// либо `snake_case`/`CONST_CASE`. Слова с заглавной (`Accept`), аббревиатуры
/// (`ACCESS`) и дефисы (`Neon-Trust`) идентификаторами НЕ считаются — их
/// можно показывать игроку.
pub fn looks_like_identifier(text: &str) -> bool {
    // snake_case / CONST_CASE: только латиница/цифры, разделённые `_`.
    let parts: Vec<&str> = text.split('_').collect();
    if parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return true;
    }
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    if !text.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    // ALLCAPS — не идентификатор.
    if text
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return false;
    }
    let humps = text.chars().filter(|c| c.is_ascii_uppercase()).count();
    if humps >= 2 {
        return true;
    }
    // `/^[a-z]+[A-Z]/`
    let mut lower = 0usize;
    let mut chars = text.chars();
    for c in chars.by_ref() {
        if c.is_ascii_lowercase() {
            lower += 1;
        } else {
            return lower > 0 && c.is_ascii_uppercase();
        }
    }
    false
}

/// Сработало ли условие правила на записи (провенанс проверяет вызывающий).
pub fn skip_condition_matches(when: SkipCondition, msgid: &str, rich: &str) -> bool {
    match when {
        SkipCondition::NoLetters => !has_letters(msgid),
        SkipCondition::ShortToken => {
            !msgid.chars().any(js_ws) && cp_len(msgid) <= SHORT_TOKEN_MAX_CHARS
        }
        SkipCondition::NoWord => !has_word(msgid),
        SkipCondition::Identifier => looks_like_identifier(msgid),
        SkipCondition::Tokens => crate::text_filters::has_subst_token(msgid),
        SkipCondition::HexColor => is_hex_color(msgid),
        SkipCondition::AssetPath => looks_like_asset_path(msgid),
        SkipCondition::Fragment => classify_rich(msgid, rich).relation == RichRelation::Suffix,
    }
}

/// `#RRGGBB` (3–8 hex-цифр) — константа цвета, а не текст для игрока.
///
/// 1:1 с TS (`hexColor` в `pot_skip.mts`). Без `#` не срабатывает: `ADDDDD`
/// и `EDDDDD` в дампе — имена Timeline-треков (`Playable Track`), а не цвета,
/// и гадать по внешнему виду мы не будем.
pub fn is_hex_color(s: &str) -> bool {
    let t = s.trim();
    let Some(rest) = t.strip_prefix('#') else {
        return false;
    };
    (3..=8).contains(&rest.chars().count()) && rest.chars().all(|c| c.is_ascii_hexdigit())
}

/// Путь к ассету (`Assets/…`, `…/Resources/…`, файл с расширением + слэш).
///
/// 1:1 с TS (`looksLikeAssetPath`). Замер 2026-11-23: в POT ровно одна такая
/// строка; `24/7 Kiosk` и `Annoyed / Angry` — настоящий текст, их не трогаем.
pub fn looks_like_asset_path(s: &str) -> bool {
    let t = py_strip(s);
    if t.to_ascii_lowercase().starts_with("assets/") {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    if lower.contains("resources/") {
        return true;
    }
    let has_slash = t.contains('/') || t.contains('\\');
    has_slash
        && [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "bmp",
            "tga",
            "psd",
            "mat",
            "asset",
            "prefab",
            "wav",
            "ogg",
            "mp3",
            "json",
            "txt",
            "xml",
            "dll",
            "cs",
            "shader",
            "anim",
            "controller",
            "unity",
            "fbx",
            "ttf",
            "otf",
            "dat",
        ]
        .iter()
        .any(|ext| lower.contains(&format!(".{ext}")))
}
