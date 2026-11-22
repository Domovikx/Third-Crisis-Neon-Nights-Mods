//! inventory.rs — инвентарь переводимых строк из JSONL-дампа Unity-ассетов.
//!
//! Порт читающей половины `.opencode/skills/extract-text/scripts/inventory.mts`
//! (поведение 1:1 — иначе POT перестанет совпадать побайтово):
//!
//! ```text
//! kind: dlg (ANToolkit dialogues), bundle (PlayMaker line_X),
//!       spk (имя персонажа), set (settings_keys.display),
//!       raw (UI-строки raw_strings), fsm (FSM-переменные)
//! ```
//!
//! Порядок пунктов `finish()` — часть контракта POT: сначала диалоги по
//! `path_id`, затем бандлы по имени, спикеры по первому появлению, settings,
//! UI и FSM по имени ассета. Меняется только вместе с TS-эталоном.
//!
//! Пути `source`/`idx` в Rust не нужны: они существовали для YAML-писателя,
//! который удалён, а в POT не попадают (YAGNI — не тащим поля без читателя).

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use rust_l10n_core::po::js_trim;

use crate::text_filters::{is_known_non_speaker, is_skip_prefix, strip_rich};

/// Вид источника строки.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Dlg,
    Bundle,
    Spk,
    Set,
    Raw,
    Fsm,
}

impl ItemKind {
    /// UI-ish виды: к ним применяется авто-триаж (`triageReason`).
    pub fn is_ui_like(self) -> bool {
        matches!(self, ItemKind::Set | ItemKind::Raw | ItemKind::Fsm)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Dlg => "dlg",
            ItemKind::Bundle => "bundle",
            ItemKind::Spk => "spk",
            ItemKind::Set => "set",
            ItemKind::Raw => "raw",
            ItemKind::Fsm => "fsm",
        }
    }
}

/// Одна строка инвентаря: ровно то, что читает `ctxtOf`/`buildCatalog`.
///
/// `source`/`idx` — провенанс для `find_source` (`[kind:source#idx]`): `pid`
/// диалога, короткое имя бандла, имя ассета UI/FSM, текст спикера. В POT они
/// не попадают (refs там не пишутся), но стоят одну ссылку на строку.
///
/// `src` — метка провенанса для POT (`#. src:`): путь, которым строка
/// ДОСТАВЛЕНА в каталог. Список фиксирован, см. `SRC_KINDS`.
#[derive(Debug, Clone)]
pub struct InventoryItem {
    pub text: String,
    pub speaker: String,
    pub rich_text: String,
    pub kind: ItemKind,
    pub source: String,
    /// Номер строки внутри источника (`null` у имён спикеров).
    pub idx: Option<usize>,
    pub src: String,
}

/// Метки провенанса без параметра (`src_labels()` — их же список для тестов).
pub const SRC_KINDS: [&str; 5] = ["dialog", "bundle", "settings", "us", "global"];

/// `field:<ИмяПоля>` / `raw:<TypeName>`: параметр — C#-идентификатор.
pub fn is_valid_src(src: &str) -> bool {
    if SRC_KINDS.contains(&src) {
        return true;
    }
    let Some(param) = src
        .strip_prefix("field:")
        .or_else(|| src.strip_prefix("raw:"))
    else {
        return false;
    };
    let mut chars = param.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[derive(Debug, Default)]
pub struct Inventory {
    pub items: Vec<InventoryItem>,
}

#[derive(Debug, Clone)]
struct DialogueEntry {
    text: String,
    speaker: String,
    rich_text: String,
}

struct PidGroup {
    pid: i64,
    entries: Vec<DialogueEntry>,
}

// ---------------------------------------------------------------------------
// Python-совместимые строковые примитивы.
//
// POT сверяется байт-в-байт, а `str.strip()`/`isupper()`/`isalpha()` в CPython
// работают по Unicode-свойствам; JS-эквиваленты в TS-эталоне уже подогнаны,
// здесь повторяем их (BOM не пробел, NEL — пробел, длина — в code points).
// ---------------------------------------------------------------------------

/// Пробел Python `str.strip()` (Unicode White_Space; BOM сюда НЕ входит).
pub fn py_ws(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | '\u{20}'
            | '\u{1c}'..='\u{1f}'
            | '\u{85}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// `str.strip()` без аргументов.
pub fn py_strip(s: &str) -> &str {
    s.trim_matches(py_ws)
}

/// Длина в code points (Python `len`), а не в UTF-16 units.
fn cp_len(s: &str) -> usize {
    s.chars().count()
}

/// Python `str.isalpha()` — свойство Alphabetic.
fn py_is_alpha(s: &str) -> bool {
    !s.is_empty() && s.chars().all(char::is_alphabetic)
}

fn py_is_upper_char(c: char) -> bool {
    c.is_uppercase()
}

fn py_is_lower_char(c: char) -> bool {
    c.is_lowercase()
}

/// Python `str.isupper()` для строки: есть заглавные, строчных нет.
fn py_is_upper(s: &str) -> bool {
    let mut has_upper = false;
    for c in s.chars() {
        if py_is_lower_char(c) {
            return false;
        }
        if py_is_upper_char(c) {
            has_upper = true;
        }
    }
    has_upper
}

fn as_string(v: Option<&Value>) -> &str {
    match v {
        Some(Value::String(s)) => s,
        _ => "",
    }
}

fn as_array(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

fn as_object(v: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    match v {
        Some(Value::Object(o)) => Some(o),
        _ => None,
    }
}

/// Строка дампа: только поля, которые читает инвентарь. Всё остальное
/// (`fields`, `type`, `summaries` и пр.) serde пропускает без аллокаций —
/// именно на этом Rust и выигрывает у `JSON.parse` на 95 МБ дампа.
#[derive(Debug, Default, Deserialize)]
pub struct DumpRow {
    #[serde(default)]
    asset: Option<Value>,
    #[serde(default)]
    path_id: Option<Value>,
    #[serde(default)]
    r#type: Option<Value>,
    #[serde(default)]
    format: Option<Value>,
    #[serde(default)]
    dialogues: Option<Value>,
    #[serde(default)]
    raw_strings: Option<Value>,
    #[serde(default)]
    fsm_strings: Option<Value>,
    #[serde(default)]
    settings_keys: Option<Value>,
    #[serde(default)]
    color_parser_list: Option<Value>,
    #[serde(default)]
    strings: Option<Value>,
    #[serde(default)]
    fields: Option<Value>,
}

// ---------------------------------------------------------------------------
// Фильтры extractor.py
// ---------------------------------------------------------------------------

/// `_resolve_named_colors`: `<color=имя>` → `<color=#hex>` из color_parser_list.
pub fn resolve_named_colors(s: &str, colors: &HashMap<String, String>) -> String {
    const OPEN: &str = "<color=";
    if !s.contains(OPEN) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find(OPEN) {
        out.push_str(&rest[..pos + OPEN.len()]);
        let after = &rest[pos + OPEN.len()..];
        let name_len = after
            .char_indices()
            .take_while(|(_, c)| c.is_alphanumeric() || *c == '_')
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        if name_len > 0 && after[name_len..].starts_with('>') {
            let name = &after[..name_len];
            if let Some(hex) = colors.get(name) {
                out.push_str(hex);
                out.push('>');
                rest = &after[name_len + 1..];
                continue;
            }
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `_is_ui_string`: похоже ли `raw_string` на UI-лейбл (1:1).
///
/// Границы 2..50 code points — историческая защита от Steamworks/Unity-шума;
/// цена фиксирована осознанно (см. `tasks/2026-11-21-pot-coverage-gaps.md`).
pub fn is_ui_string(s: &str) -> bool {
    let len = cp_len(s);
    if s.is_empty() || !(2..=50).contains(&len) {
        return false;
    }
    let chars: Vec<char> = s.chars().collect();
    // Свойства шейдеров/Unity: подчёркивание + заглавная.
    if s.starts_with('_') && len > 2 && py_is_upper_char(chars[1]) {
        return false;
    }
    // GUID и чистый hex.
    if is_guid_prefix(s) {
        return false;
    }
    if len > 6 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    // Отладочные сообщения.
    let lower = s.to_lowercase();
    const CODE_PATTERNS: [&str; 33] = [
        "must be",
        "is out of",
        "is not ",
        "cannot ",
        "doesn't",
        "don't ",
        "not found",
        "not initialized",
        "not null",
        "is null",
        "is empty",
        "must not",
        "is bigger",
        "is smaller",
        "is invalid",
        "is unknown",
        "size of",
        "count is",
        "range of",
        "index ",
        "array",
        "function ",
        "parameter",
        "argument",
        "exception",
        "error:",
        "warning:",
        "origins",
        "handles",
        "properties",
        "serializ",
        "deserializ",
        "callback",
    ];
    const CODE_PATTERNS_REST: [&str; 2] = ["steam", "unity "];
    if CODE_PATTERNS.iter().any(|p| lower.contains(p))
        || CODE_PATTERNS_REST.iter().any(|p| lower.contains(p))
    {
        return false;
    }
    // C#-имена полей с точками (Namespace.Field, Base Layer.Idle). Эвристика
    // срабатывает на любую строку с точкой и заглавной в первых 5 code points.
    if s.contains('.') {
        let head: Vec<char> = s.split('.').next().unwrap_or("").chars().take(5).collect();
        if head.iter().any(|c| py_is_upper_char(*c)) {
            return false;
        }
    }
    if s.contains('<') || s.contains('>') || s.contains('{') || s.contains('}') {
        return false;
    }
    if s.contains('(') && s.contains(')') {
        return false;
    }
    // Пути и файлы.
    if s.starts_with("actions/") || s.starts_with("expressions/") || s.starts_with("Textures/") {
        return false;
    }
    if s.contains('/') && s.contains('\\') {
        return false;
    }
    if s.ends_with(".cs") || s.ends_with(".dll") || s.ends_with(".json") {
        return false;
    }
    // Имена состояний анимаций/ассетов.
    if [
        "Normal",
        "Highlighted",
        "Pressed",
        "Selected",
        "Disabled",
        "Active",
    ]
    .contains(&s)
    {
        return false;
    }
    // ALL CAPS с гласными = кнопка (BACK, HIDE, SKIP, LOG, OPTIONS).
    if py_is_upper(s) && (2..=25).contains(&len) {
        return "AEIOU".chars().any(|v| s.contains(v));
    }
    // Многословный лейбл (New Game, Dialogue Log, LOAD GAME).
    if s.contains(' ') {
        return true;
    }
    // Короткий PascalCase без пробела (Back, Continue, Skip, Resume).
    if py_is_upper_char(chars[0])
        && chars[1..].iter().any(|c| py_is_lower_char(*c))
        && (2..=15).contains(&len)
    {
        return !["FSM", "FSMs", "GUID", "Data"].contains(&s);
    }
    false
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}` без учёта регистра.
fn is_guid_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 13 {
        return false;
    }
    if !bytes[..8].iter().all(u8::is_ascii_hexdigit) || bytes[8] != b'-' {
        return false;
    }
    bytes[9..13].iter().all(u8::is_ascii_hexdigit)
}

// ---------------------------------------------------------------------------
// Аккумулятор: один проход по дампу собирает всё, что нужно potgen.
// ---------------------------------------------------------------------------

/// Упорядоченная карта «ключ → значение» с семантикой JS `Map`:
/// первый ключ задаёт порядок, повторная вставка заменяет значение на месте.
struct OrderedMap<V> {
    keys: Vec<String>,
    index: HashMap<String, usize>,
    values: Vec<V>,
}

// Ручной Default: derive добавил бы требование `V: Default`, которое для
// `PidGroup`/`Vec<...>` не нужно (пустые векторы создаются сами).
impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            index: HashMap::new(),
            values: Vec::new(),
        }
    }
}

impl<V> OrderedMap<V> {
    fn get_or_insert_with(&mut self, key: &str, make: impl FnOnce() -> V) -> &mut V {
        if let Some(&i) = self.index.get(key) {
            return &mut self.values[i];
        }
        self.index.insert(key.to_string(), self.keys.len());
        self.keys.push(key.to_string());
        self.values.push(make());
        self.values.last_mut().expect("значение добавлено")
    }

    fn set(&mut self, key: &str, value: V) {
        if let Some(&i) = self.index.get(key) {
            self.values[i] = value;
            return;
        }
        self.index.insert(key.to_string(), self.keys.len());
        self.keys.push(key.to_string());
        self.values.push(value);
    }

    fn into_sorted_by_key(
        self,
        cmp: impl Fn(&str, &str) -> std::cmp::Ordering,
    ) -> Vec<(String, V)> {
        let mut pairs: Vec<(String, V)> = self.keys.into_iter().zip(self.values).collect();
        pairs.sort_by(|a, b| cmp(&a.0, &b.0));
        pairs
    }

    fn into_pairs(self) -> Vec<(String, V)> {
        self.keys.into_iter().zip(self.values).collect()
    }
}

/// Сравнение строк по code points (порядок Python `str`). Для UTF-8 это
/// совпадает с побайтовым сравнением, то есть с `str::cmp`.
fn compare_code_points(a: &str, b: &str) -> std::cmp::Ordering {
    a.cmp(b)
}

/// Порядок имён файлов как у файловой системы Windows (без регистра, затем
/// code points). На порядок влияет только «первое вхождение побеждает».
fn compare_file_names(a: &str, b: &str) -> std::cmp::Ordering {
    let na = a.to_lowercase();
    let nb = b.to_lowercase();
    na.cmp(&nb).then_with(|| compare_code_points(a, b))
}

/// `_BUNDLE_HASH_RX` (`_(assets|scenes)_all_[a-f0-9]+$`): убрать хвост-хэш
/// имени бандла — стабильное короткое имя для `#:`-провенанса.
pub fn bundle_short_name(asset_name: &str) -> String {
    let tail = |marker: &str| asset_name.rfind(marker).map(|i| (i, marker.len()));
    for marker in ["_assets_all_", "_scenes_all_"] {
        if let Some((pos, len)) = tail(marker) {
            let hash = &asset_name[pos + len..];
            if !hash.is_empty()
                && hash
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
            {
                return asset_name[..pos].to_string();
            }
        }
    }
    asset_name.to_string()
}

/// Верхнеуровневый `"path_id"` из сырой строки (BigInt-точность в TS).
/// Unity `path_id` — знаковый 64-битный хэш; i64 покрывает его целиком, а
/// `JSON.parse` терял точность выше 2^53 (22 pid в реальном дампе).
fn path_id_of(raw_line: &str, row: &DumpRow) -> Option<i64> {
    row.path_id.as_ref()?;
    if let Some(text) = raw_path_id(raw_line) {
        return text.parse::<i64>().ok();
    }
    match row.path_id.as_ref() {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_u64().map(|v| v as i64)),
        _ => None,
    }
}

/// `(?<!\\)"path_id"\s*:\s*(-?\d+)` — левое совпадение вне JSON-эскейпа.
fn raw_path_id(raw_line: &str) -> Option<&str> {
    const KEY: &str = "\"path_id\"";
    let bytes = raw_line.as_bytes();
    let mut from = 0usize;
    while let Some(pos) = raw_line[from..].find(KEY) {
        let start = from + pos;
        let escaped = start > 0 && bytes[start - 1] == b'\\';
        let after_key = start + KEY.len();
        let rest = &raw_line[after_key..];
        let mut it = rest.char_indices().peekable();
        while it
            .peek()
            .is_some_and(|(_, c)| rust_l10n_core::po::js_ws(*c))
        {
            it.next();
        }
        if let Some((_, ':')) = it.peek().copied() {
            it.next();
            while it
                .peek()
                .is_some_and(|(_, c)| rust_l10n_core::po::js_ws(*c))
            {
                it.next();
            }
            let digits_start = after_key + it.peek().map(|(i, _)| *i).unwrap_or(rest.len());
            let tail = &raw_line[digits_start..];
            let (sign, body) = match tail.strip_prefix('-') {
                Some(b) => (1usize, b),
                None => (0usize, tail),
            };
            let len = body.bytes().take_while(u8::is_ascii_digit).count();
            if !escaped && len > 0 {
                return Some(&raw_line[digits_start..digits_start + sign + len]);
            }
        }
        from = start + KEY.len();
    }
    None
}

/// Индекс «значение → имя типизированного поля» для одной строки дампа.
///
/// `strings` — скалярные строковые поля (m_Name, DisplayName, m_text…),
/// `fields` — прочие поля, включая массивы строк. Ключи в дампе уже
/// отсортированы генератором, а `serde_json::Map` по умолчанию — `BTreeMap`,
/// поэтому порядок тот же, что в TS (явная сортировка там); при совпадении
/// значения в двух полях побеждает первое по имени.
fn typed_field_index(row: &DumpRow) -> HashMap<String, String> {
    fn add(index: &mut HashMap<String, String>, name: &str, value: &Value) {
        if let Value::String(s) = value {
            index
                .entry(s.clone())
                .or_insert_with(|| format!("field:{name}"));
        }
    }
    let mut index: HashMap<String, String> = HashMap::new();
    if let Some(Value::Object(strings)) = row.strings.as_ref() {
        for (name, value) in strings {
            add(&mut index, name, value);
        }
    }
    if let Some(Value::Object(fields)) = row.fields.as_ref() {
        for (name, value) in fields {
            if let Value::Array(items) = value {
                for item in items {
                    add(&mut index, name, item);
                }
            }
        }
    }
    index
}

/// Накопитель строк дампа (порт `DumpScanner`).
#[derive(Default)]
pub struct DumpScanner {
    dialogues: OrderedMap<PidGroup>,
    bundles: OrderedMap<Vec<DialogueEntry>>,
    bundle_seen: HashSet<(String, String)>,
    settings: OrderedMap<Vec<(String, String)>>,
    chunk_ui: OrderedMap<Vec<(String, String)>>,
    ui_local_seen: HashMap<String, HashSet<String>>,
    ui_global_seen: HashSet<String>,
    fsm: OrderedMap<Vec<String>>,
    fsm_local_seen: HashMap<String, HashSet<String>>,
    fsm_global_seen: HashSet<String>,
    colors: HashMap<String, String>,
}

impl DumpScanner {
    /// Одна строка чанка (`level*.jsonl`, `bundle_*.jsonl`, `resources.jsonl`).
    pub fn add_chunk_row(&mut self, row: &DumpRow, raw_line: &str) {
        self.collect_colors(row);
        self.collect_dialogues(row, raw_line);
        self.collect_bundle(row);
        self.collect_chunk_ui(row);
        self.collect_fsm(row);
    }

    /// Одна строка `summaries.jsonl` (`stem` — имя ассета из строки).
    pub fn add_summary_row(&mut self, row: &DumpRow, stem: &str) {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut entries: Vec<(String, String)> = Vec::new();
        // DLL-строка несёт два потока в одном `settings_keys`: ключи
        // `Settings.*` (подпись синтезирована из имени) и автономные UI-строки
        // из кучи `#US` (там `key == display`). Различаем по ключу.
        let dotnet = as_string(row.format.as_ref()) == "dotnet_us_heap";
        for raw in as_array(row.settings_keys.as_ref()) {
            let Some(sk) = as_object(Some(raw)) else {
                continue;
            };
            // Python: display.strip().strip("\x00") — сначала пробелы, затем NUL.
            let display = as_string(sk.get("display"));
            let text = py_strip(display).trim_matches('\u{0}');
            if text.is_empty() || seen.contains(text) || text.contains('\u{0}') {
                continue;
            }
            seen.insert(text);
            let key = as_string(sk.get("key"));
            let src = if dotnet && !key.starts_with("Settings.") {
                "us"
            } else {
                "settings"
            };
            entries.push((text.to_string(), src.to_string()));
        }
        if !entries.is_empty() {
            self.settings.set(stem, entries);
        }
    }

    /// Собрать итоговый инвентарь в порядке `scan_dump()` из TS-эталона.
    pub fn finish(self) -> Inventory {
        let mut items: Vec<InventoryItem> = Vec::new();

        // Диалоги: группы по path_id, отсортированы по числовому значению.
        let mut groups: Vec<(i64, Vec<DialogueEntry>)> = self
            .dialogues
            .into_pairs()
            .into_iter()
            .map(|(_, g)| (g.pid, g.entries))
            .collect();
        groups.sort_by_key(|(pid, _)| *pid);
        for (pid, entries) in &groups {
            for (idx, e) in entries.iter().enumerate() {
                items.push(InventoryItem {
                    text: e.text.clone(),
                    speaker: e.speaker.clone(),
                    rich_text: resolve_named_colors(&e.rich_text, &self.colors),
                    kind: ItemKind::Dlg,
                    source: pid.to_string(),
                    idx: Some(idx),
                    src: "dialog".to_string(),
                });
            }
        }

        // Бандлы: по имени ассета (code points).
        let bundles = self.bundles.into_sorted_by_key(compare_code_points);
        for (asset, entries) in &bundles {
            for (idx, e) in entries.iter().enumerate() {
                items.push(InventoryItem {
                    text: e.text.clone(),
                    speaker: e.speaker.clone(),
                    rich_text: resolve_named_colors(&e.rich_text, &self.colors),
                    kind: ItemKind::Bundle,
                    source: bundle_short_name(asset),
                    idx: Some(idx),
                    src: "bundle".to_string(),
                });
            }
        }

        // Спикеры: порядок первого появления среди диалогов, затем бандлов
        // (порядок вставки, НЕ отсортированный). Провенанс имени — источник
        // первого появления.
        let mut seen_speakers: HashSet<String> = HashSet::new();
        let mut speakers: Vec<String> = Vec::new();
        let mut speaker_src: HashMap<String, &'static str> = HashMap::new();
        let sources = groups
            .iter()
            .map(|(_, e)| (e, "dialog"))
            .chain(bundles.iter().map(|(_, e)| (e, "bundle")));
        for (entries, src) in sources {
            for e in entries {
                let sp = py_strip(&e.speaker);
                if !sp.is_empty() && seen_speakers.insert(sp.to_string()) {
                    speakers.push(sp.to_string());
                    speaker_src.insert(sp.to_string(), src);
                }
            }
        }
        for sp in speakers {
            items.push(InventoryItem {
                text: sp.clone(),
                speaker: String::new(),
                rich_text: String::new(),
                kind: ItemKind::Spk,
                source: sp.clone(),
                idx: None,
                src: speaker_src
                    .get(&sp)
                    .copied()
                    .unwrap_or("dialog")
                    .to_string(),
            });
        }

        for (source, entries) in self.settings.into_sorted_by_key(compare_code_points) {
            for (idx, (text, src)) in entries.into_iter().enumerate() {
                items.push(InventoryItem {
                    text,
                    speaker: String::new(),
                    rich_text: String::new(),
                    kind: ItemKind::Set,
                    source: source.clone(),
                    idx: Some(idx),
                    src,
                });
            }
        }

        for (source, entries) in self.chunk_ui.into_sorted_by_key(compare_code_points) {
            for (idx, (text, src)) in entries.into_iter().enumerate() {
                items.push(InventoryItem {
                    text,
                    speaker: String::new(),
                    rich_text: String::new(),
                    kind: ItemKind::Raw,
                    source: source.clone(),
                    idx: Some(idx),
                    src,
                });
            }
        }

        for (source, entries) in self.fsm.into_sorted_by_key(compare_code_points) {
            for (idx, text) in entries.into_iter().enumerate() {
                items.push(InventoryItem {
                    text,
                    speaker: String::new(),
                    rich_text: String::new(),
                    kind: ItemKind::Fsm,
                    source: source.clone(),
                    idx: Some(idx),
                    // FSM-строки — значения типизированного поля `fsm`.
                    src: "field:fsm".to_string(),
                });
            }
        }

        Inventory { items }
    }

    fn collect_colors(&mut self, row: &DumpRow) {
        let Some(cpl) = as_object(row.color_parser_list.as_ref()) else {
            return;
        };
        for (name, hex) in cpl {
            if let Value::String(hex) = hex {
                self.colors.insert(name.clone(), hex.clone());
            }
        }
    }

    fn collect_dialogues(&mut self, row: &DumpRow, raw_line: &str) {
        let raw = as_array(row.dialogues.as_ref());
        if raw.is_empty() {
            return;
        }
        let Some(pid) = path_id_of(raw_line, row) else {
            return;
        };
        let key = pid.to_string();
        let group = self.dialogues.get_or_insert_with(&key, || PidGroup {
            pid,
            entries: Vec::new(),
        });

        // `seen` живёт в пределах ОДНОГО объекта дампа: одинаковые
        // (text, speaker) в разных строках одного path_id не дедупятся.
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for raw_entry in raw {
            let Some(d) = as_object(Some(raw_entry)) else {
                continue;
            };
            let text = py_strip(as_string(d.get("text")));
            if text.is_empty() {
                continue;
            }
            let speaker = py_strip(as_string(d.get("speaker")));
            let key = (text.to_string(), speaker.to_string());
            if !seen.insert(key) {
                continue;
            }
            group.entries.push(DialogueEntry {
                text: text.to_string(),
                speaker: speaker.to_string(),
                rich_text: py_strip(as_string(d.get("rich_text"))).to_string(),
            });
        }
    }

    fn collect_bundle(&mut self, row: &DumpRow) {
        let asset = as_string(row.asset.as_ref());
        if !asset.starts_with("bundle_") {
            return;
        }
        let entries = self
            .bundles
            .get_or_insert_with(asset, Vec::<DialogueEntry>::new);

        let all = as_array(row.raw_strings.as_ref());
        if all.is_empty() {
            return;
        }
        let rs: Vec<&str> = all
            .iter()
            .filter_map(|s| match s {
                Value::String(v) => Some(v.as_str()),
                _ => None,
            })
            .collect();
        // Признак PlayMaker-бандла: в raw есть ключи line_X. Арт/аудио-бандлы
        // отсекаются здесь, иначе их имена попали бы в POT как диалоги.
        if !rs.iter().any(|s| s.starts_with("line_")) {
            return;
        }
        let obj_name = as_object(row.strings.as_ref())
            .map(|s| as_string(s.get("m_Name")))
            .unwrap_or("");

        let mut i = 0usize;
        while i < rs.len() {
            let s = py_strip(rs[i]);
            if is_skip_prefix(s) || s == obj_name {
                i += 1;
                continue;
            }
            if cp_len(s) <= 3 || !s.contains(' ') {
                i += 1;
                continue;
            }
            if s.starts_with('{') || s.starts_with('[') {
                i += 1;
                continue;
            }
            let clean = strip_rich(s);
            if clean.is_empty() || cp_len(&clean) < 4 {
                i += 1;
                continue;
            }
            // rich_text — исходная строка с тегами (если отличается от clean).
            let rich_text = if s != clean { s } else { "" };

            let mut speaker = "";
            if i + 1 < rs.len() {
                let ns = py_strip(rs[i + 1]);
                let first = ns.chars().next().unwrap_or('\0');
                if !ns.is_empty()
                    && !is_skip_prefix(ns)
                    && !ns.starts_with("line_")
                    && ns != obj_name
                    && !ns.contains(' ')
                    && py_is_upper_char(first)
                    && py_is_alpha(ns)
                    && !is_known_non_speaker(ns)
                {
                    speaker = ns;
                    i += 1;
                }
            }

            if self
                .bundle_seen
                .insert((clean.clone(), speaker.to_string()))
            {
                entries.push(DialogueEntry {
                    text: clean,
                    speaker: speaker.to_string(),
                    rich_text: rich_text.to_string(),
                });
            }
            i += 1;
        }
    }

    fn collect_chunk_ui(&mut self, row: &DumpRow) {
        let asset = {
            let a = as_string(row.asset.as_ref());
            if a.is_empty() {
                "unknown"
            } else {
                a
            }
        };
        let entries = self
            .chunk_ui
            .get_or_insert_with(asset, Vec::<(String, String)>::new);
        let local = self.ui_local_seen.entry(asset.to_string()).or_default();

        let type_name = {
            let t = as_string(row.r#type.as_ref());
            if t.is_empty() {
                "unknown"
            } else {
                t
            }
        };
        // Индекс типизированных полей — только если строка прошла фильтр
        // (на реальном дампе это экономит разбор `fields` у 99 % объектов).
        let mut typed: Option<HashMap<String, String>> = None;

        // Дедуп глобальный (на весь дамп): один и тот же лейбл из разных сцен
        // даёт одну запись. Для перевода это верно (текст один).
        for raw in as_array(row.raw_strings.as_ref()) {
            let Value::String(raw) = raw else {
                continue;
            };
            let s = py_strip(raw);
            if s.is_empty()
                || local.contains(s)
                || self.ui_global_seen.contains(s)
                || s.contains('\u{0}')
            {
                continue;
            }
            if !is_ui_string(s) {
                continue;
            }
            local.insert(s.to_string());
            self.ui_global_seen.insert(s.to_string());
            let index = typed.get_or_insert_with(|| typed_field_index(row));
            let src = index
                .get(s)
                .cloned()
                .unwrap_or_else(|| format!("raw:{type_name}"));
            entries.push((s.to_string(), src));
        }
    }

    fn collect_fsm(&mut self, row: &DumpRow) {
        let asset = {
            let a = as_string(row.asset.as_ref());
            if a.is_empty() {
                "unknown"
            } else {
                a
            }
        };
        let entries = self.fsm.get_or_insert_with(asset, Vec::<String>::new);
        let local = self.fsm_local_seen.entry(asset.to_string()).or_default();

        for raw in as_array(row.fsm_strings.as_ref()) {
            let s = match raw {
                Value::String(v) => py_strip(v),
                _ => "",
            };
            if s.is_empty()
                || local.contains(s)
                || self.fsm_global_seen.contains(s)
                || s.contains('\u{0}')
            {
                continue;
            }
            local.insert(s.to_string());
            self.fsm_global_seen.insert(s.to_string());
            entries.push(s.to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// Файловый слой
// ---------------------------------------------------------------------------

/// Все JSONL-чанки: `<dump>/*.jsonl` без `summaries.jsonl`.
pub fn find_chunks(dump_dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut names: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(dump_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".jsonl") && name != "summaries.jsonl" {
            names.push(name);
        }
    }
    names.sort_by(|a, b| compare_file_names(a, b));
    Ok(names.into_iter().map(|n| dump_dir.join(n)).collect())
}

/// `summaries.jsonl`, если есть.
pub fn find_summaries(dump_dir: &Path) -> Vec<PathBuf> {
    let path = dump_dir.join("summaries.jsonl");
    if path.is_file() {
        vec![path]
    } else {
        Vec::new()
    }
}

/// Построчный разбор JSONL: битые строки и не-объекты молча пропускаются
/// (как `iter_jsonl_objects` в Python и `readJsonl` в TS-эталоне).
fn for_each_row(path: &Path, mut f: impl FnMut(&DumpRow, &str)) -> std::io::Result<()> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
    loop {
        buf.clear();
        let read = reader.read_until(b'\n', &mut buf)?;
        if read == 0 {
            break;
        }
        let raw = std::str::from_utf8(&buf).unwrap_or("");
        let line = js_trim(raw);
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<DumpRow>(line) else {
            continue;
        };
        f(&row, line);
    }
    Ok(())
}

/// Прочитать дамп целиком (потоково) и собрать инвентарь.
pub fn scan_dump(dump_dir: &Path) -> Result<Inventory, String> {
    if !dump_dir.is_dir() {
        return Err(format!(
            "dump not found: {} (сначала запусти dump-assets)",
            dump_dir.display()
        ));
    }
    let chunks = find_chunks(dump_dir).map_err(|e| format!("{}: {e}", dump_dir.display()))?;
    let summaries = find_summaries(dump_dir);
    let mut scanner = DumpScanner::default();

    for fp in &chunks {
        for_each_row(fp, |obj, line| scanner.add_chunk_row(obj, line))
            .map_err(|e| format!("{}: {e}", fp.display()))?;
    }
    for fp in &summaries {
        for_each_row(fp, |row, _| {
            let stem = match row.asset.as_ref() {
                Some(Value::String(s)) => s.as_str(),
                _ => "summaries",
            };
            scanner.add_summary_row(row, stem);
        })
        .map_err(|e| format!("{}: {e}", fp.display()))?;
    }

    Ok(scanner.finish())
}
