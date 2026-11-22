//! audit.rs — независимый аудит POT/PO/DAT.
//!
//! Инструмент только читает. Все проверки детерминированы и не зависят от
//! пайплайна: PO-парсер общий с генераторами (один взгляд на файл), но правила
//! — свои. Каждая находка привязана к файлу/строке (или индексу записи) и к
//! классу из [`crate::classes`].

use std::collections::BTreeMap;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use rust_l10n_core::po::{js_ws, parse_po, PoEntry};
use serde_json::Value;

use crate::classes::{class_def, ClassDef};
use crate::noise::{is_noise, NoiseCount};
use crate::text::{
    backslash_count, double_escape_markers, ends_sentence, ends_with_word_char, has_letters,
    invisibles, line_ids, looks_linguistic, looks_sentence_like, mixed_alpha_tokens,
    mojibake_evidence, normalize_ws, numeric_runs, placeholders, strip_invisible, tag_issues,
    tag_presence_diff, typographic_latin, Invisible,
};

/// Одна находка: где, что и почему.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub loc: String,
    pub text: String,
    pub detail: String,
}

/// Результат по классу: полный счётчик и ограниченная выборка примеров.
#[derive(Clone, Debug)]
pub struct ClassResult {
    pub def: &'static ClassDef,
    pub count: usize,
    pub samples: Vec<Finding>,
}

/// Калибровочные числа (проверяются против известных значений в docs/data-audit.md).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Calibration {
    pub pot_noise: NoiseCount,
    pub po_noise_entries: usize,
    pub po_noise_translated: usize,
    pub dat_raw_tag_rows: usize,
    pub dat_rich_both_rows: usize,
    pub dat_filtered_tag_rows: usize,
    pub dat_font_only_rows: usize,
    pub collapse_groups: usize,
}

/// Полный отчёт по одному языку.
#[derive(Clone, Debug)]
pub struct LangAudit {
    pub lang: String,
    pub pot_entries: usize,
    pub po_entries: usize,
    pub po_filled: usize,
    pub dat_rows: usize,
    pub classes: BTreeMap<&'static str, ClassResult>,
    pub calibration: Calibration,
}

/// Отчёт по самому POT (общие для всех языков проверки выполняются один раз).
#[derive(Clone, Debug)]
pub struct PotAudit {
    pub entries: usize,
    pub classes: BTreeMap<&'static str, ClassResult>,
    pub calibration: Calibration,
}

impl PotAudit {
    pub fn count(&self, id: &str) -> usize {
        self.classes.get(id).map(|c| c.count).unwrap_or(0)
    }
}

impl LangAudit {
    /// Счётчик класса (0 для «проверено, чисто»).
    pub fn count(&self, id: &str) -> usize {
        self.classes.get(id).map(|c| c.count).unwrap_or(0)
    }

    /// Классы уровня `error` с ненулевым счётчиком.
    pub fn error_count(&self) -> usize {
        self.classes
            .values()
            .filter(|c| c.count > 0 && c.def.level == crate::classes::Level::Error)
            .count()
    }
}

// ── Сборщик находок ──────────────────────────────────────────────────────

struct Collector {
    classes: BTreeMap<&'static str, ClassResult>,
    enabled: bool,
}

impl Collector {
    fn new() -> Self {
        Self::with_enabled(true)
    }

    /// Сборщик-заглушка: считает калибровку, но не копит находки
    /// (POT проверяется один раз отдельным `PotAudit`).
    fn disabled() -> Self {
        Self::with_enabled(false)
    }

    fn with_enabled(enabled: bool) -> Self {
        let classes = crate::classes::CLASSES
            .iter()
            .map(|def| {
                (
                    def.id,
                    ClassResult {
                        def,
                        count: 0,
                        samples: Vec::new(),
                    },
                )
            })
            .collect();
        Self { classes, enabled }
    }

    fn add(
        &mut self,
        id: &'static str,
        loc: impl Into<String>,
        text: impl Into<String>,
        detail: impl Into<String>,
    ) {
        if !self.enabled {
            return;
        }
        let def = class_def(id).expect("класс зарегистрирован в CLASSES");
        let result = self
            .classes
            .get_mut(id)
            .expect("класс инициализирован в Collector::new");
        result.count += 1;
        if result.samples.len() < def.sample_cap {
            result.samples.push(Finding {
                loc: loc.into(),
                text: text.into(),
                detail: detail.into(),
            });
        }
    }
}

// ── Сырой скан PO-строк ──────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct RawIssue {
    line: usize,
    text: String,
    detail: String,
}

#[derive(Default)]
struct RawScan {
    malformed: Vec<RawIssue>,
    unknown_escape: Vec<RawIssue>,
}

const FIELDS: [&str; 3] = ["msgid", "msgctxt", "msgstr"];

/// Значение поля `msgid "..."` — как в общем парсере (первая и последняя кавычка).
fn field_value(line: &str) -> Option<&str> {
    for kw in FIELDS {
        let Some(rest) = line.strip_prefix(kw) else {
            continue;
        };
        let trimmed = rest.trim_start_matches(js_ws);
        if trimmed.len() == rest.len() {
            return None; // нет пробела после ключевого слова
        }
        if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
            return Some(&trimmed[1..trimmed.len() - 1]);
        }
        return None;
    }
    None
}

fn scan_unknown_escapes(content: &str) -> Vec<String> {
    let chars: Vec<char> = content.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '\\' {
            i += 1;
            continue;
        }
        match chars.get(i + 1) {
            Some('n' | 'r' | 't' | '"' | '\\') => i += 2,
            Some(next) => {
                let marker = format!("\\{next}");
                if !out.contains(&marker) {
                    out.push(marker);
                }
                i += 2;
            }
            None => {
                out.push("\\<конец строки>".to_string());
                i += 1;
            }
        }
    }
    out
}

/// Пройти по сырому тексту: битые поля и неизвестные escape-последовательности.
fn raw_scan(text: &str) -> RawScan {
    let mut scan = RawScan::default();
    for (i, line) in text.lines().enumerate() {
        let lineno = i + 1;
        let trimmed = line.trim();
        if let Some(content) = field_value(trimmed) {
            let unknown = scan_unknown_escapes(content);
            if !unknown.is_empty() {
                scan.unknown_escape.push(RawIssue {
                    line: lineno,
                    text: trimmed.chars().take(100).collect(),
                    detail: unknown.join(", "),
                });
            }
            continue;
        }
        if FIELDS.iter().any(|kw| trimmed.starts_with(kw)) {
            scan.malformed.push(RawIssue {
                line: lineno,
                text: trimmed.chars().take(100).collect(),
                detail: "поле не разбирается: нет пробела или закрывающей кавычки".to_string(),
            });
            continue;
        }
        if trimmed.starts_with('"') {
            if trimmed.len() >= 2 && trimmed.ends_with('"') {
                let content = &trimmed[1..trimmed.len() - 1];
                let unknown = scan_unknown_escapes(content);
                if !unknown.is_empty() {
                    scan.unknown_escape.push(RawIssue {
                        line: lineno,
                        text: trimmed.chars().take(100).collect(),
                        detail: unknown.join(", "),
                    });
                }
            } else {
                scan.malformed.push(RawIssue {
                    line: lineno,
                    text: trimmed.chars().take(100).collect(),
                    detail: "незакрытая строка-продолжение".to_string(),
                });
            }
        }
    }
    scan
}

/// Номера строк, с которых начинаются блоки записей (для адресов в отчёте).
fn block_starts(text: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut prev_blank = true;
    for (i, line) in text.lines().enumerate() {
        let blank = line.trim().is_empty();
        if !blank && prev_blank {
            starts.push(i + 1);
        }
        prev_blank = blank;
    }
    starts
}

fn loc(label: &str, starts: &[usize], entries: usize, index: usize) -> String {
    if starts.len() == entries && starts.get(index).is_some_and(|n| *n > 0) {
        format!("{label}:{}", starts[index])
    } else {
        format!("{label}#{index}")
    }
}

// ── Данные .dat ──────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct DatRow {
    t: String,
    x: String,
    r: String,
    rt: String,
    line: usize,
}

fn read_dat(text: &str, label: &str, collector: &mut Collector) -> Vec<DatRow> {
    let mut rows: Vec<DatRow> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (i, line) in text.lines().enumerate() {
        let lineno = i + 1;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                collector.add(
                    "dat.parse-error",
                    format!("{label}:{lineno}"),
                    line.chars().take(100).collect::<String>(),
                    format!("JSON не разобран: {e}"),
                );
                continue;
            }
        };
        let Value::Object(map) = value else {
            collector.add(
                "dat.parse-error",
                format!("{label}:{lineno}"),
                line.chars().take(100).collect::<String>(),
                "строка не JSON-объект".to_string(),
            );
            continue;
        };
        let t = match map.get("t") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => {
                collector.add(
                    "dat.parse-error",
                    format!("{label}:{lineno}"),
                    line.chars().take(100).collect::<String>(),
                    "нет непустого строкового поля t".to_string(),
                );
                continue;
            }
        };
        let mut field_error = None;
        let mut get_str = |key: &str| -> String {
            match map.get(key) {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(other) => {
                    field_error = Some(format!("поле {key} не строка: {other}"));
                    String::new()
                }
            }
        };
        let x = get_str("x");
        let r = get_str("r");
        let rt = get_str("rt");
        if let Some(e) = field_error {
            collector.add(
                "dat.parse-error",
                format!("{label}:{lineno}"),
                t.chars().take(80).collect::<String>(),
                e,
            );
            continue;
        }
        let unknown: Vec<&str> = map
            .keys()
            .map(String::as_str)
            .filter(|k| !matches!(*k, "t" | "x" | "r" | "rt" | "sk"))
            .collect();
        if !unknown.is_empty() {
            collector.add(
                "dat.unknown-field",
                format!("{label}:{lineno}"),
                t.chars().take(80).collect::<String>(),
                format!("ключи: {}", unknown.join(", ")),
            );
        }
        if let Some(first) = seen.get(&t) {
            collector.add(
                "dat.duplicate-key",
                format!("{label}:{lineno}"),
                t.chars().take(80).collect::<String>(),
                format!("первая строка: {first}"),
            );
            continue;
        }
        seen.insert(t.clone(), lineno);
        rows.push(DatRow {
            t,
            x,
            r,
            rt,
            line: lineno,
        });
    }
    rows
}

// ── Проверки ─────────────────────────────────────────────────────────────

fn rich_of(entry: &PoEntry) -> Option<String> {
    entry
        .comments
        .iter()
        .find_map(|c| c.strip_prefix("rich_text:").map(|s| s.trim().to_string()))
}

fn rich_override(entry: &PoEntry) -> Option<String> {
    entry
        .translator
        .iter()
        .find_map(|c| c.strip_prefix("rich:").map(|s| s.trim().to_string()))
}

/// Копия оригинала — реально непереведённая фраза, а не имя/термин/шум.
fn copy_is_human(text: &str, ctxt: &str) -> bool {
    if ctxt == "speaker-name" || is_noise(text) || !looks_linguistic(text) {
        return false;
    }
    looks_sentence_like(text)
}

fn check_raw(label: &str, scan: &RawScan, collector: &mut Collector) {
    for issue in &scan.malformed {
        collector.add(
            "po.malformed-field",
            format!("{label}:{}", issue.line),
            issue.text.clone(),
            issue.detail.clone(),
        );
    }
    for issue in &scan.unknown_escape {
        collector.add(
            "po.escape.unknown",
            format!("{label}:{}", issue.line),
            issue.text.clone(),
            issue.detail.clone(),
        );
    }
}

fn check_pot(
    entries: &[PoEntry],
    label: &str,
    starts: &[usize],
    collector: &mut Collector,
    calibration: &mut Calibration,
) -> HashMap<String, String> {
    let body: Vec<&PoEntry> = if entries.first().is_some_and(|e| e.msgid.is_empty()) {
        entries.iter().skip(1).collect()
    } else {
        entries.iter().collect()
    };
    let mut by_key: HashMap<(String, String), Vec<usize>> = HashMap::new();
    let mut rich: HashMap<String, String> = HashMap::new();

    for (idx, entry) in body.iter().enumerate() {
        let line = loc(
            label,
            starts,
            entries.len(),
            idx + entries.len() - body.len(),
        );
        if entry.msgid.is_empty() {
            collector.add(
                "po.empty-msgid",
                line,
                "(пусто)",
                "запись POT без msgid".to_string(),
            );
            continue;
        }
        calibration.pot_noise.add(&entry.msgid);
        if is_noise(&entry.msgid) {
            collector.add(
                "pot.noise",
                line.clone(),
                entry.msgid.clone(),
                "шум по фильтрам пайплайна",
            );
        }
        by_key
            .entry((entry.msgctxt.clone(), entry.msgid.clone()))
            .or_default()
            .push(idx + 1);
        if let Some(rich_text) = rich_of(entry) {
            if !rich.contains_key(&entry.msgid) {
                rich.insert(entry.msgid.clone(), rich_text.clone());
            }
            let issues = tag_issues(&rich_text);
            for detail in issues.balance {
                collector.add(
                    "po.tag.balance",
                    line.clone(),
                    entry.msgid.clone(),
                    format!("rich_text: {detail}"),
                );
            }
            for detail in issues.unclosed {
                collector.add(
                    "po.tag.unclosed",
                    line.clone(),
                    entry.msgid.clone(),
                    format!("rich_text: {detail}"),
                );
            }
            for detail in issues.nesting {
                collector.add(
                    "po.tag.nesting",
                    line.clone(),
                    entry.msgid.clone(),
                    format!("rich_text: {detail}"),
                );
            }
        }
    }

    for ((ctxt, msgid), indexes) in &by_key {
        if indexes.len() < 2 {
            continue;
        }
        let line = loc(label, starts, entries.len(), indexes[0]);
        collector.add(
            "pot.duplicate-key",
            line,
            msgid.clone(),
            format!("msgctxt={ctxt:?}: {} вхождений", indexes.len()),
        );
    }
    rich
}

fn check_po_text(lang: &str, entry: &PoEntry, line: &str, collector: &mut Collector) {
    let msgid = entry.msgid.as_str();
    let msgstr = entry.msgstr.as_str();
    if is_noise(msgid) {
        return;
    }

    // Невидимые символы — и в источнике, и в переводе.
    for (field, value) in [("msgid", msgid), ("msgstr", msgstr)] {
        let found = invisibles(value);
        if found.is_empty() {
            continue;
        }
        let nbsp: Vec<String> = found
            .iter()
            .filter(|(_, kind, _)| *kind == Invisible::Nbsp)
            .map(|(c, _, n)| format!("U+{:04X}×{n}", *c as u32))
            .collect();
        let hidden: Vec<String> = found
            .iter()
            .filter(|(_, kind, _)| *kind != Invisible::Nbsp)
            .map(|(c, kind, n)| format!("{} U+{:04X}×{n}", kind.label(), *c as u32))
            .collect();
        if !nbsp.is_empty() {
            collector.add(
                "po.encoding.nbsp",
                line.to_string(),
                msgid.to_string(),
                format!("{field}: {}", nbsp.join(", ")),
            );
        }
        if !hidden.is_empty() {
            collector.add(
                "po.encoding.zero-width",
                line.to_string(),
                msgid.to_string(),
                format!("{field}: {}", hidden.join(", ")),
            );
        }
    }

    if msgstr.is_empty() || msgstr.trim().is_empty() {
        if has_letters(msgid) {
            collector.add(
                "po.anchor.empty",
                line.to_string(),
                msgid.to_string(),
                "msgstr пуст".to_string(),
            );
        }
        return;
    }

    for (field, value) in [("msgid", msgid), ("msgstr", msgstr)] {
        let markers = double_escape_markers(value);
        if !markers.is_empty() {
            collector.add(
                "po.escape.double",
                line.to_string(),
                msgid.to_string(),
                format!("{field}: {}", markers.join(", ")),
            );
        } else if backslash_count(value) > 0 && looks_linguistic(value) {
            collector.add(
                "po.escape.backslash",
                line.to_string(),
                msgid.to_string(),
                format!("{field}: {} обратных слэшей", backslash_count(value)),
            );
        }
    }

    let mojibake = mojibake_evidence(msgstr);
    if !mojibake.is_empty() {
        collector.add(
            "po.encoding.mojibake",
            line.to_string(),
            msgid.to_string(),
            mojibake.join(", "),
        );
    }
    let mixed = mixed_alpha_tokens(msgstr);
    if !mixed.is_empty() {
        collector.add(
            "po.encoding.mixed-alpha",
            line.to_string(),
            msgid.to_string(),
            format!("msgstr: {}", mixed.join(", ")),
        );
    }
    let typographic = typographic_latin(msgstr);
    if !typographic.is_empty() {
        let note = if lang == "fr" {
            " (для fr это норма)"
        } else {
            ""
        };
        collector.add(
            "po.encoding.typographic",
            line.to_string(),
            msgid.to_string(),
            format!("msgstr: {}{note}", typographic.join(", ")),
        );
    }

    let issues = tag_issues(msgstr);
    for detail in issues.balance {
        collector.add(
            "po.tag.balance",
            line.to_string(),
            msgid.to_string(),
            format!("msgstr: {detail}"),
        );
    }
    for detail in issues.unclosed {
        collector.add(
            "po.tag.unclosed",
            line.to_string(),
            msgid.to_string(),
            format!("msgstr: {detail}"),
        );
    }
    for detail in issues.nesting {
        collector.add(
            "po.tag.nesting",
            line.to_string(),
            msgid.to_string(),
            format!("msgstr: {detail}"),
        );
    }
    let baseline = msgid;
    let (missing, extra) = tag_presence_diff(baseline, msgstr);
    if !missing.is_empty() {
        collector.add(
            "po.tag.missing",
            line.to_string(),
            msgid.to_string(),
            format!("нет в переводе: {}", missing.join(", ")),
        );
    }
    if !extra.is_empty() {
        collector.add(
            "po.tag.extra",
            line.to_string(),
            msgid.to_string(),
            format!("лишние в переводе: {}", extra.join(", ")),
        );
    }

    if looks_linguistic(msgid) {
        let origin_numbers = numeric_runs(msgid);
        let translated_numbers = numeric_runs(msgstr);
        if origin_numbers != translated_numbers {
            collector.add(
                "po.anchor.numbers",
                line.to_string(),
                msgid.to_string(),
                format!("{origin_numbers:?} → {translated_numbers:?}"),
            );
        }
        let origin_ids = line_ids(msgid);
        let translated_ids = line_ids(msgstr);
        if origin_ids != translated_ids {
            collector.add(
                "po.anchor.line-ids",
                line.to_string(),
                msgid.to_string(),
                format!("{origin_ids:?} → {translated_ids:?}"),
            );
        }
        let origin_ph = placeholders(msgid);
        let translated_ph = placeholders(msgstr);
        if origin_ph != translated_ph {
            collector.add(
                "po.anchor.placeholders",
                line.to_string(),
                msgid.to_string(),
                format!("{origin_ph:?} → {translated_ph:?}"),
            );
        }
        if msgstr.chars().count() == 1 && msgid.chars().count() >= 4 {
            collector.add(
                "po.anchor.single-char",
                line.to_string(),
                msgid.to_string(),
                format!("msgstr: {msgstr:?}"),
            );
        }
        if ends_sentence(msgid)
            && !ends_sentence(msgstr)
            && ends_with_word_char(msgstr)
            && msgid.split_whitespace().count() >= 4
        {
            collector.add(
                "po.anchor.truncated",
                line.to_string(),
                msgid.to_string(),
                format!("msgid: {msgid:?} / msgstr: {msgstr:?}"),
            );
        }
    }
}

fn check_po(
    lang: &str,
    entries: &[PoEntry],
    label: &str,
    starts: &[usize],
    pot_entries: &[PoEntry],
    collector: &mut Collector,
    calibration: &mut Calibration,
) {
    let header = usize::from(entries.first().is_some_and(|e| e.msgid.is_empty()));
    let body: Vec<(usize, &PoEntry)> = entries.iter().enumerate().skip(header).collect();

    let mut by_key: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (idx, entry) in &body {
        let line = loc(label, starts, entries.len(), *idx);
        if entry.msgid.is_empty() {
            collector.add(
                "po.empty-msgid",
                line,
                "(пусто)",
                "запись PO без msgid".to_string(),
            );
            continue;
        }
        if is_noise(&entry.msgid) {
            calibration.po_noise_entries += 1;
            if !entry.msgstr.is_empty() {
                calibration.po_noise_translated += 1;
            }
        }
        by_key
            .entry((entry.msgctxt.clone(), entry.msgid.clone()))
            .or_default()
            .push(*idx);
        if !entry.msgstr.is_empty() && entry.msgstr == entry.msgid {
            if copy_is_human(&entry.msgid, &entry.msgctxt) {
                collector.add(
                    "po.copy-through",
                    line.clone(),
                    entry.msgid.clone(),
                    "msgstr == msgid".to_string(),
                );
            } else {
                collector.add(
                    "po.copy-through-noise",
                    line.clone(),
                    entry.msgid.clone(),
                    "msgstr == msgid (шум/имя/термин)".to_string(),
                );
            }
        }
        check_po_text(lang, entry, &line, collector);
    }

    // Дубликаты ключей.
    for ((ctxt, msgid), indexes) in &by_key {
        if indexes.len() < 2 {
            continue;
        }
        let mut variants: Vec<String> = Vec::new();
        for idx in indexes {
            let msgstr = &entries[*idx].msgstr;
            if !variants.contains(msgstr) {
                variants.push(msgstr.clone());
            }
        }
        let line = loc(label, starts, entries.len(), indexes[0]);
        if variants.len() > 1 {
            variants.sort();
            collector.add(
                "po.duplicate-key-diff",
                line,
                msgid.clone(),
                format!("msgctxt={ctxt:?}: {variants:?}"),
            );
        } else {
            collector.add(
                "po.duplicate-key-same",
                line,
                msgid.clone(),
                format!("msgctxt={ctxt:?}: {} вхождений", indexes.len()),
            );
        }
    }

    // Orphans / missing / дрейф ключа.
    let pot_by_key: HashSet<(String, String)> = pot_entries
        .iter()
        .filter(|e| !e.msgid.is_empty())
        .map(|e| (e.msgctxt.clone(), e.msgid.clone()))
        .collect();
    let pot_texts: HashSet<&str> = pot_entries
        .iter()
        .filter(|e| !e.msgid.is_empty())
        .map(|e| e.msgid.as_str())
        .collect();
    let mut norm: HashMap<(String, String), &str> = HashMap::new();
    for e in pot_entries.iter().filter(|e| !e.msgid.is_empty()) {
        norm.entry((normalize_ws(&e.msgid), e.msgctxt.clone()))
            .or_insert(e.msgid.as_str());
        norm.entry((normalize_ws(&strip_invisible(&e.msgid)), e.msgctxt.clone()))
            .or_insert(e.msgid.as_str());
    }

    for ((ctxt, msgid), indexes) in &by_key {
        if pot_by_key.contains(&(ctxt.clone(), msgid.clone())) {
            continue;
        }
        let line = loc(label, starts, entries.len(), indexes[0]);
        if pot_texts.contains(msgid.as_str()) {
            collector.add(
                "po.orphan-context",
                line,
                msgid.clone(),
                format!("msgctxt={ctxt:?}: в POT такого контекста нет"),
            );
            continue;
        }
        let drift = norm
            .get(&(normalize_ws(msgid), ctxt.clone()))
            .or_else(|| norm.get(&(normalize_ws(&strip_invisible(msgid)), ctxt.clone())));
        match drift {
            Some(original) if *original != msgid => collector.add(
                "po.key-drift",
                line,
                msgid.clone(),
                format!("POT: {original:?} / PO: {msgid:?}"),
            ),
            _ => collector.add(
                "po.orphan-text",
                line,
                msgid.clone(),
                format!("msgctxt={ctxt:?}: текста нет в POT"),
            ),
        }
    }

    for e in pot_entries.iter().filter(|e| !e.msgid.is_empty()) {
        if !by_key.contains_key(&(e.msgctxt.clone(), e.msgid.clone())) {
            collector.add(
                "po.missing-key",
                label.to_string(),
                e.msgid.clone(),
                format!("msgctxt={:?}: ключа нет в PO", e.msgctxt),
            );
        }
    }
}

fn tag_seq(s: &str, include_render: bool) -> Vec<String> {
    crate::text::parse_tags(s)
        .into_iter()
        .filter(|t| include_render || !crate::text::is_render_owned(&t.name))
        .map(|t| format!("{}{}", if t.closing { "/" } else { "" }, t.name))
        .collect()
}

fn check_collapse(
    po_entries: &[PoEntry],
    label: &str,
    collector: &mut Collector,
    calibration: &mut Calibration,
) {
    let mut variants: HashMap<&str, Vec<&PoEntry>> = HashMap::new();
    for e in po_entries.iter().filter(|e| !e.msgid.is_empty()) {
        variants.entry(e.msgid.as_str()).or_default().push(e);
    }
    for (text, group) in variants {
        let mut distinct: Vec<&str> = Vec::new();
        for v in &group {
            if !v.msgstr.is_empty() && !distinct.contains(&v.msgstr.as_str()) {
                distinct.push(&v.msgstr);
            }
        }
        if distinct.len() <= 1 {
            continue;
        }
        calibration.collapse_groups += 1;
        let detail: Vec<String> = group
            .iter()
            .filter(|v| !v.msgstr.is_empty())
            .map(|v| {
                format!(
                    "{} => {}",
                    v.msgctxt,
                    v.msgstr.chars().take(60).collect::<String>()
                )
            })
            .collect();
        collector.add(
            "dat.collapse",
            label.to_string(),
            text.to_string(),
            detail.join(" | "),
        );
    }
}

fn check_dat(
    po_entries: &[PoEntry],
    pot_entries: &[PoEntry],
    pot_rich: &HashMap<String, String>,
    dat_text: Option<&str>,
    label: &str,
    collector: &mut Collector,
    calibration: &mut Calibration,
) -> usize {
    let Some(text) = dat_text else {
        collector.add(
            "dat.missing-file",
            label.to_string(),
            "(файл)",
            "runtime/*.dat не найден".to_string(),
        );
        return 0;
    };
    let rows = read_dat(text, label, collector);
    let by_text: HashMap<&str, &DatRow> = rows.iter().map(|r| (r.t.as_str(), r)).collect();

    let pot_texts: HashSet<&str> = pot_entries
        .iter()
        .filter(|e| !e.msgid.is_empty())
        .map(|e| e.msgid.as_str())
        .collect();
    let mut po_variants: HashMap<&str, Vec<&PoEntry>> = HashMap::new();
    for e in po_entries.iter().filter(|e| !e.msgid.is_empty()) {
        po_variants.entry(e.msgid.as_str()).or_default().push(e);
    }

    // Строки словаря, которых нет в источнике.
    for row in &rows {
        if po_variants.contains_key(row.t.as_str()) {
            continue;
        }
        let line = format!("{label}:{}", row.line);
        if pot_texts.contains(row.t.as_str()) {
            collector.add(
                "dat.not-in-po",
                line,
                row.t.chars().take(80).collect::<String>(),
                "текст есть в POT, но не в PO".to_string(),
            );
        } else {
            collector.add(
                "dat.not-in-pot",
                line,
                row.t.chars().take(80).collect::<String>(),
                "текста нет ни в POT, ни в PO".to_string(),
            );
        }
    }

    for (text_key, variants) in &po_variants {
        let any_filled = variants.iter().any(|v| !v.msgstr.is_empty());
        let any_ok = variants
            .iter()
            .any(|v| !v.msgstr.is_empty() && !v.flags.iter().any(|f| f == "auto-normalized"));
        let gated_only = any_filled && !any_ok;

        let row = by_text.get(text_key);
        match row {
            None => {
                if pot_rich.contains_key(*text_key) && !gated_only {
                    collector.add(
                        "dat.rich-lost",
                        label.to_string(),
                        text_key.to_string(),
                        "нет строки, хотя в POT есть rich_text".to_string(),
                    );
                }
                if any_ok {
                    collector.add(
                        "dat.lost-translation",
                        label.to_string(),
                        text_key.to_string(),
                        "перевод есть в PO, строки в .dat нет".to_string(),
                    );
                }
            }
            Some(row) => {
                let line = format!("{label}:{}", row.line);
                if row.x.is_empty() {
                    if any_ok {
                        collector.add(
                            "dat.lost-translation",
                            line.clone(),
                            text_key.to_string(),
                            "x пуст при заполненном msgstr".to_string(),
                        );
                    }
                } else {
                    if !any_filled {
                        collector.add(
                            "dat.invented",
                            line.clone(),
                            text_key.to_string(),
                            format!("x={:?} без источника в PO", row.x),
                        );
                    } else if !variants.iter().any(|v| v.msgstr == row.x) {
                        collector.add(
                            "dat.mismatch",
                            line.clone(),
                            text_key.to_string(),
                            format!("x={:?} не равен ни одному msgstr", row.x),
                        );
                    }
                    if row.x == row.t {
                        if copy_is_human(&row.t, "") {
                            collector.add(
                                "dat.copy-through",
                                line.clone(),
                                row.t.clone(),
                                "x == t".to_string(),
                            );
                        } else {
                            collector.add(
                                "dat.copy-through-noise",
                                line.clone(),
                                row.t.clone(),
                                "x == t (шум/имя/термин)".to_string(),
                            );
                        }
                    }
                }

                match pot_rich.get(*text_key) {
                    Some(rich) => {
                        if row.r != *rich {
                            let id = if row.r.is_empty() {
                                "dat.rich-lost"
                            } else {
                                "dat.rich-mismatch"
                            };
                            collector.add(
                                id,
                                line.clone(),
                                text_key.to_string(),
                                format!("r={:?}, POT rich_text={:?}", row.r, rich),
                            );
                        }
                    }
                    None if !row.r.is_empty() => {
                        collector.add(
                            "dat.rich-extra",
                            line.clone(),
                            text_key.to_string(),
                            format!("r={:?}, в POT rich_text нет", row.r),
                        );
                    }
                    None => {}
                }

                let overrides: Vec<String> =
                    variants.iter().filter_map(|v| rich_override(v)).collect();
                if !row.rt.is_empty() {
                    if !overrides.is_empty() && !overrides.contains(&row.rt) {
                        collector.add(
                            "dat.rt-mismatch",
                            line.clone(),
                            text_key.to_string(),
                            format!("rt={:?}, PO rich={:?}", row.rt, overrides),
                        );
                    }
                    let rt_issues = tag_issues(&row.rt);
                    for detail in rt_issues.balance {
                        collector.add(
                            "dat.rt-balance",
                            line.clone(),
                            text_key.to_string(),
                            format!("rt: {detail}"),
                        );
                    }
                    for detail in rt_issues.unclosed {
                        collector.add(
                            "dat.rt-unclosed",
                            line.clone(),
                            text_key.to_string(),
                            format!("rt: {detail}"),
                        );
                    }
                    for detail in rt_issues.nesting {
                        collector.add(
                            "dat.rt-balance",
                            line.clone(),
                            text_key.to_string(),
                            format!("rt: {detail}"),
                        );
                    }
                    let (missing, extra) = tag_presence_diff(&row.r, &row.rt);
                    if !missing.is_empty() || !extra.is_empty() {
                        collector.add(
                            "dat.rt-tags",
                            line.clone(),
                            text_key.to_string(),
                            format!("r → rt: нет {:?}, лишние {:?}", missing, extra),
                        );
                    }
                } else if !overrides.is_empty() {
                    collector.add(
                        "dat.rt-mismatch",
                        line.clone(),
                        text_key.to_string(),
                        format!("в PO есть rich={:?}, в .dat rt пуст", overrides),
                    );
                }

                if !row.r.is_empty() && !row.rt.is_empty() {
                    calibration.dat_rich_both_rows += 1;
                    let raw_r = tag_seq(&row.r, true);
                    let raw_t = tag_seq(&row.rt, true);
                    let filtered_r = tag_seq(&row.r, false);
                    let filtered_t = tag_seq(&row.rt, false);
                    if raw_r != raw_t {
                        calibration.dat_raw_tag_rows += 1;
                    }
                    if filtered_r != filtered_t {
                        calibration.dat_filtered_tag_rows += 1;
                    } else if raw_r != raw_t {
                        calibration.dat_font_only_rows += 1;
                    }
                }
            }
        }
    }

    // Ожидаемые строки, которых нет вовсе, уже сообщены как lost/rich-lost
    // внутри прохода по текстам PO.

    rows.len()
}

// ── Публичный вход ───────────────────────────────────────────────────────

/// Прогнать аудит на строках (для тестов и для CLI после чтения файлов).
pub fn audit_strings(
    lang: &str,
    pot_text: &str,
    po_text: &str,
    dat_text: Option<&str>,
) -> LangAudit {
    audit_strings_opts(lang, pot_text, po_text, dat_text, true)
}

/// То же, но с возможностью отключить проверку `.dat` (калибровка только PO).
pub fn audit_strings_opts(
    lang: &str,
    pot_text: &str,
    po_text: &str,
    dat_text: Option<&str>,
    check_dat_file: bool,
) -> LangAudit {
    let pot_label = "po/template.pot";
    let po_label = format!("po/{lang}.po");
    let dat_label = format!("runtime/patch_{lang}.dat");

    let pot_entries = parse_po(pot_text);
    let po_entries = parse_po(po_text);
    let pot_body_len = if pot_entries.first().is_some_and(|e| e.msgid.is_empty()) {
        pot_entries.len().saturating_sub(1)
    } else {
        pot_entries.len()
    };
    let po_body_len = if po_entries.first().is_some_and(|e| e.msgid.is_empty()) {
        po_entries.len().saturating_sub(1)
    } else {
        po_entries.len()
    };

    let mut collector = Collector::new();
    let mut calibration = Calibration::default();

    let pot_starts = block_starts(pot_text);
    let po_starts = block_starts(po_text);
    let pot_scan = raw_scan(pot_text);
    let po_scan = raw_scan(po_text);
    // POT общий для всех языков: проверим его один раз в `audit_pot`,
    // здесь нужны только rich-карта и калибровка шума.
    let mut pot_discard = Collector::disabled();
    check_raw(pot_label, &pot_scan, &mut pot_discard);
    check_raw(&po_label, &po_scan, &mut collector);

    let pot_rich = check_pot(
        &pot_entries,
        pot_label,
        &pot_starts,
        &mut pot_discard,
        &mut calibration,
    );
    check_po(
        lang,
        &po_entries,
        &po_label,
        &po_starts,
        &pot_entries,
        &mut collector,
        &mut calibration,
    );
    check_collapse(&po_entries, &dat_label, &mut collector, &mut calibration);
    let dat_rows = if check_dat_file {
        check_dat(
            &po_entries,
            &pot_entries,
            &pot_rich,
            dat_text,
            &dat_label,
            &mut collector,
            &mut calibration,
        )
    } else {
        0
    };

    let po_filled = po_entries
        .iter()
        .filter(|e| !e.msgid.is_empty() && !e.msgstr.is_empty())
        .count();

    LangAudit {
        lang: lang.to_string(),
        pot_entries: pot_body_len,
        po_entries: po_body_len,
        po_filled,
        dat_rows,
        classes: collector.classes,
        calibration,
    }
}

/// Аудит самого POT (один раз на прогон, независимо от языков).
pub fn audit_pot(pot_text: &str) -> PotAudit {
    let pot_label = "po/template.pot";
    let entries = parse_po(pot_text);
    let body_len = if entries.first().is_some_and(|e| e.msgid.is_empty()) {
        entries.len().saturating_sub(1)
    } else {
        entries.len()
    };
    let starts = block_starts(pot_text);
    let scan = raw_scan(pot_text);
    let mut collector = Collector::new();
    let mut calibration = Calibration::default();
    check_raw(pot_label, &scan, &mut collector);
    let _rich = check_pot(
        &entries,
        pot_label,
        &starts,
        &mut collector,
        &mut calibration,
    );
    PotAudit {
        entries: body_len,
        classes: collector.classes,
        calibration,
    }
}

/// Прочитать файлы и прогнать аудит.
pub fn audit_files(
    lang: &str,
    pot_path: &Path,
    po_path: &Path,
    dat_path: Option<&Path>,
) -> std::io::Result<LangAudit> {
    let pot = std::fs::read_to_string(pot_path)?;
    let po = std::fs::read_to_string(po_path)?;
    let dat = match dat_path {
        Some(path) if path.exists() => Some(std::fs::read_to_string(path)?),
        _ => None,
    };
    Ok(audit_strings(lang, &pot, &po, dat.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_value_matches_parser() {
        assert_eq!(field_value("msgid \"abc\""), Some("abc"));
        assert_eq!(field_value("msgid  \"abc\""), Some("abc"));
        assert_eq!(field_value("msgid\"abc\""), None);
        assert_eq!(field_value("msgid \"abc"), None);
        assert_eq!(field_value("# msgid \"abc\""), None);
    }

    #[test]
    fn unknown_escapes() {
        assert_eq!(scan_unknown_escapes("a\\nb"), Vec::<String>::new());
        assert_eq!(scan_unknown_escapes("a\\\\b"), Vec::<String>::new());
        assert_eq!(scan_unknown_escapes("a\\qb"), vec!["\\q".to_string()]);
        assert_eq!(
            scan_unknown_escapes("a\\"),
            vec!["\\<конец строки>".to_string()]
        );
    }

    #[test]
    fn block_starts_count_blocks() {
        let text = "# c\nmsgid \"a\"\nmsgstr \"\"\n\nmsgid \"b\"\nmsgstr \"\"\n";
        assert_eq!(block_starts(text), vec![1, 5]);
    }
}
