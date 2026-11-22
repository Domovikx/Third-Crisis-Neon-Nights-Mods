//! prefill.rs — предзаполнение `po/<lang>.po` из YAML-корпуса переводов.
//!
//! Порт `.opencode/skills/extract-text/scripts/prefill_po.mts` (поведение 1:1,
//! паритет — гейт `scripts/text_parity.test.mts`). Это НЕ перевод, а измерение
//! миграции: каждый msgstr берётся из существующего корпуса `translations/`
//! (историческое YAML-дерево):
//!
//! - coverage: у ключа POT есть точный (msgid, msgctxt) перевод;
//! - fuzzy: ключ не совпал, но для голого текста есть РОВНО ОДИН вариант;
//! - conflicts: один (text, ctxt) с РАЗНЫМИ переводами — решает человек;
//! - missing: перевода нет нигде (очередь переводчика);
//! - orphans: перевод без записи в POT (приёмка: 0 — ноль тихих потерь);
//! - skipped_with_translation: skip-флаг + реальный перевод (ручной триаж).
//!
//! Подтверждённые человеком msgstr в существующем PO не пересчитываются:
//! состояние человека священно (как в оригинале).
//!
//! ВНИМАНИЕ: YAML-корпус — легаси-вход; в этой репе дерева `translations/` нет,
//! поэтому без `--corpus` инструмент сохраняет текущие переводы и печатает
//! отчёт (все POT-строки без перевода попадают в `missing`).
//!
//! CLI: `rust-l10n prefill [lang] [--po-dir <dir>] [--corpus <dir>]
//!       [--root <dir>] [--created "<date>"]`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use rust_l10n_core::po::{js_trim, parse_po, render_po, PoEntry};

use crate::po_update::write_atomic;

/// Корень репозитория по умолчанию для CLI/тестов.
pub const DEFAULT_LANG: &str = "ru";

/// Строка YAML-корпуса, нормализованная под prefill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusEntry {
    pub text: String,
    pub translation: String,
    pub skip_translation: bool,
    pub speaker: String,
    /// Путь файла относительно родителя корпуса, как `as_posix()` в Python.
    pub rel: String,
}

/// Один вариант перевода голого текста: значение + файл-источник.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuVariant {
    pub translation: String,
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedWithTranslation {
    pub text: String,
    pub ctxt: String,
    pub translation: String,
    pub file: String,
}

/// Ключ (msgid, msgctxt) в порядке Python-кортежа.
pub type PrefillKey = (String, String);

// ---------------------------------------------------------------------------
// Мини-читатель YAML-корпуса
//
// Корпус — плоский список словарей (`- key: "value"` / `  key: "value"`),
// значения в двойных кавычках (эскейпы `\\`, `\"`, `\n`), `skip_translation`
// — голый `true`. Полный YAML не нужен (и не должен тянуть зависимость).
// ---------------------------------------------------------------------------

/// Значение YAML-скаляра: строка, булево или null.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YamlScalar {
    Str(String),
    Bool(bool),
    Null,
}

impl YamlScalar {
    fn as_str(&self) -> Option<&str> {
        match self {
            YamlScalar::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// Раскодировать двойной скаляр YAML (включая `\xXX` / `\uXXXX` / `\UXXXXXXXX`).
pub fn yaml_unescape_double(s: &str) -> String {
    fn simple(c: char) -> Option<char> {
        Some(match c {
            '0' => '\0',
            'a' => '\u{7}',
            'b' => '\u{8}',
            't' => '\t',
            'n' => '\n',
            'v' => '\u{b}',
            'f' => '\u{c}',
            'r' => '\r',
            'e' => '\u{1b}',
            ' ' => ' ',
            '"' => '"',
            '/' => '/',
            '\\' => '\\',
            'N' => '\u{85}',
            '_' => '\u{a0}',
            'L' => '\u{2028}',
            'P' => '\u{2029}',
            _ => return None,
        })
    }

    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c != '\\' || i + 1 >= chars.len() {
            out.push(c);
            i += 1;
            continue;
        }
        let n = chars[i + 1];
        let hex_len = match n {
            'x' => 2,
            'u' => 4,
            'U' => 8,
            _ => 0,
        };
        if hex_len > 0 {
            let hex: String = chars
                .iter()
                .skip(i + 2)
                .take(hex_len)
                .take_while(|c| c.is_ascii_hexdigit())
                .collect();
            if hex.len() == hex_len {
                if let Ok(code) = u32::from_str_radix(&hex, 16) {
                    // Одиночный суррогат в Rust-строку не кладётся; в реальном
                    // корпусе таких эскейпов нет — заменяем на U+FFFD.
                    out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    i += 2 + hex_len;
                    continue;
                }
            }
        }
        match simple(n) {
            Some(v) => out.push(v),
            // Неизвестный эскейп = сам символ (yaml-совместимо).
            None => out.push(n),
        }
        i += 2;
    }
    out
}

/// Значение после `key:` → примитив (строка/булево/null).
pub fn yaml_scalar(raw: &str) -> YamlScalar {
    let s = js_trim(raw);
    let bytes = s.as_bytes();
    if s.starts_with('"') && s.len() >= 2 && s.ends_with('"') {
        return YamlScalar::Str(yaml_unescape_double(&s[1..s.len() - 1]));
    }
    if s.starts_with('\'') && s.len() >= 2 && s.ends_with('\'') {
        return YamlScalar::Str(s[1..s.len() - 1].replace("''", "'"));
    }
    match s {
        "true" | "True" => YamlScalar::Bool(true),
        "false" | "False" => YamlScalar::Bool(false),
        "" | "null" | "Null" | "~" => YamlScalar::Null,
        _ => {
            let _ = bytes;
            YamlScalar::Str(s.to_string())
        }
    }
}

/// Разбить `key: value` (уже обрезанную строку) по регексу
/// `^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$`.
pub fn yaml_key_line(line: &str) -> Option<(&str, &str)> {
    let ws = |c: char| c.is_whitespace();
    let mut rest = line.trim_start_matches(ws);
    if let Some(after) = rest.strip_prefix('-') {
        let trimmed = after.trim_start_matches(ws);
        // `-\s+`: без пробела после дефиса префикс не префикс.
        if trimmed.len() != after.len() {
            rest = trimmed;
        }
    }
    let first = rest.chars().next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let key_len = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    let key = &rest[..key_len];
    let after_key = &rest[key_len..];
    let value = after_key.trim_start_matches(ws).strip_prefix(':')?;
    Some((key, value.trim_start_matches(ws)))
}

/// Прочитать YAML-файл корпуса как список словарей.
///
/// Пустой файл / файл-словарь (в корпусе есть `test.yaml`) → `[]`, как
/// `read_yaml()` в extractor.py (там не-список уходит в line-fallback).
pub fn read_yaml_entries(path: &Path) -> Vec<BTreeMap<String, YamlScalar>> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut entries: Vec<BTreeMap<String, YamlScalar>> = Vec::new();
    let mut cur: Option<BTreeMap<String, YamlScalar>> = None;
    for raw_line in split_lines(&text) {
        let line = js_trim(raw_line);
        if line.is_empty() || line.starts_with('#') {
            // Пустая строка/комментарий закрывают текущую запись.
            if let Some(c) = cur.take() {
                entries.push(c);
            }
            continue;
        }
        let Some((key, raw_value)) = yaml_key_line(line) else {
            continue; // неизвестная строка — молча пропускаем
        };
        let value = yaml_scalar(raw_value);
        if cur.is_none() || line.starts_with("- ") {
            if let Some(c) = cur.take() {
                entries.push(c);
            }
            cur = Some(BTreeMap::new());
        }
        cur.as_mut()
            .expect("запись создана")
            .insert(key.to_string(), value);
    }
    if let Some(c) = cur {
        entries.push(c);
    }
    entries
}

/// `/\r\n|\r|\n/` (CRLF — один разделитель).
fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                out.push(&text[start..i]);
                i += if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    2
                } else {
                    1
                };
                start = i;
            }
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    out.push(&text[start..]);
    out
}

/// Записи корпуса в детерминированном порядке: dialogues → settings → raw
/// (файлы внутри — code-point sort), затем speakers.yaml.
pub fn iter_source_entries(corpus_root: &Path) -> Vec<CorpusEntry> {
    let mut files: Vec<PathBuf> = Vec::new();
    for sub in ["dialogues", "settings", "raw"] {
        let dir = corpus_root.join(sub);
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = Vec::new();
        for entry in read.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".yaml") {
                names.push(name);
            }
        }
        names.sort();
        files.extend(names.into_iter().map(|n| dir.join(n)));
    }
    let speakers = corpus_root.join("speakers.yaml");
    if speakers.is_file() {
        files.push(speakers);
    }

    let parent = corpus_root
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| corpus_root.to_path_buf());
    let mut out: Vec<CorpusEntry> = Vec::new();
    for fp in &files {
        let rel = fp
            .strip_prefix(&parent)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| fp.to_string_lossy().replace('\\', "/"));
        for e in read_yaml_entries(fp) {
            let Some(text) = e.get("text").and_then(YamlScalar::as_str) else {
                continue;
            };
            if text.is_empty() {
                continue;
            }
            out.push(CorpusEntry {
                text: text.to_string(),
                translation: e
                    .get("translation")
                    .and_then(YamlScalar::as_str)
                    .unwrap_or("")
                    .to_string(),
                skip_translation: e.get("skip_translation") == Some(&YamlScalar::Bool(true)),
                speaker: e
                    .get("speaker")
                    .and_then(YamlScalar::as_str)
                    .unwrap_or("")
                    .to_string(),
                rel: rel.clone(),
            });
        }
    }
    out
}

/// Контекст записи — ДОЛЖЕН совпадать с potgen/prefill/po2yaml.
pub fn entry_context(e: &CorpusEntry) -> String {
    if e.rel == "translations/speakers.yaml" {
        return "speaker-name".to_string();
    }
    let speaker = js_trim(&e.speaker);
    if !speaker.is_empty() {
        return format!("speaker:{speaker}");
    }
    "ui".to_string()
}

/// Агрессивная нормальная форма для twin-матчинга (прикрыта правилом
/// «ровно один вариант»): маркеры, пунктуация, апострофы и растяжения букв
/// выкидываются, разные слова остаются разными.
pub fn normalize_text(input: &str) -> String {
    let lowered = input.to_lowercase();
    let stripped: String = lowered.replace(['\'', '\u{2019}'], "");
    let mut mapped = String::with_capacity(stripped.len());
    for c in stripped.chars() {
        // `[^a-zа-яё ]` → пробел: всё, что не строчная латиница/кириллица,
        // включая переводы строк и табы.
        if c.is_ascii_lowercase() || matches!(c, 'а'..='я' | 'ё') || c == ' ' {
            mapped.push(c);
        } else {
            mapped.push(' ');
        }
    }
    // `(.)\1{2,}` → `$1`: серия из трёх и более одинаковых символов → один.
    let mut collapsed = String::with_capacity(mapped.len());
    let mut prev: Option<char> = None;
    let mut run = 0usize;
    for c in mapped.chars() {
        if Some(c) == prev {
            run += 1;
        } else {
            push_run(&mut collapsed, prev, run);
            prev = Some(c);
            run = 1;
        }
    }
    push_run(&mut collapsed, prev, run);
    // `\s+` → " " и `trim()`.
    let mut out = String::with_capacity(collapsed.len());
    let mut pending_space = false;
    for c in collapsed.chars() {
        if rust_l10n_core::po::js_ws(c) {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(c);
    }
    out
}

/// Дописать серию одинаковых символов: 1–2 как есть, 3+ — один символ.
fn push_run(out: &mut String, ch: Option<char>, run: usize) {
    let Some(ch) = ch else { return };
    if run >= 3 {
        out.push(ch);
    } else {
        for _ in 0..run {
            out.push(ch);
        }
    }
}

/// Заблокированные нормальные формы (человек уже отклонил автозаполнение).
pub fn load_blocklist(po_dir: &Path) -> HashSet<String> {
    let path = po_dir.join("autofill_blocklist.txt");
    let mut blocked: HashSet<String> = HashSet::new();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return blocked;
    };
    for raw_line in split_lines(&text) {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if !line.is_empty() {
            blocked.insert(line.to_string());
        }
    }
    blocked
}

/// Корпус: (text, ctxt) → варианты перевода в порядке файлов корпуса.
#[derive(Debug, Default)]
pub struct RuCorpus {
    pub map: BTreeMap<PrefillKey, Vec<RuVariant>>,
    pub skipped_with_translation: Vec<SkippedWithTranslation>,
}

/// Собрать корпус: (text, ctxt) → варианты + список «skip с переводом».
pub fn build_ru_corpus(entries: &[CorpusEntry]) -> RuCorpus {
    let mut corpus = RuCorpus::default();
    for e in entries {
        if e.text.is_empty() {
            continue;
        }
        let ctxt = entry_context(e);
        if e.skip_translation {
            if !e.translation.is_empty() && e.translation != e.text {
                corpus
                    .skipped_with_translation
                    .push(SkippedWithTranslation {
                        text: e.text.clone(),
                        ctxt,
                        translation: e.translation.clone(),
                        file: e.rel.clone(),
                    });
            }
            continue;
        }
        if e.translation.is_empty() {
            continue;
        }
        corpus
            .map
            .entry((e.text.clone(), ctxt))
            .or_default()
            .push(RuVariant {
                translation: e.translation.clone(),
                file: e.rel.clone(),
            });
    }
    corpus
}

#[derive(Debug, Default, Clone)]
pub struct PrefillReport {
    pub total: usize,
    pub exact: usize,
    pub fuzzy: Vec<(PrefillKey, String)>,
    pub auto_normalized: Vec<(PrefillKey, String)>,
    pub conflicts: Vec<(PrefillKey, Vec<RuVariant>)>,
    pub missing: Vec<PrefillKey>,
    pub orphans: Vec<(PrefillKey, Vec<RuVariant>)>,
    pub skipped_with_translation: Vec<SkippedWithTranslation>,
}

#[derive(Debug, Clone)]
pub struct BuildRuPoInput<'a> {
    pub pot_text: &'a str,
    /// Содержимое текущего `<lang>.po` (None — файла нет).
    pub old_po_text: Option<&'a str>,
    pub corpus: &'a [CorpusEntry],
    pub blocked: &'a HashSet<String>,
}

/// Заполнить записи PO. Возвращает (записи, отчёт).
///
/// Человеческое состояние священно: существующие комментарии переводчика
/// переносятся, а подтверждённые переводы (msgstr без флага `auto-normalized`)
/// никогда не пересчитываются заново.
pub fn build_ru_po(input: &BuildRuPoInput<'_>) -> (Vec<PoEntry>, PrefillReport) {
    let pot_entries: Vec<PoEntry> = parse_po(input.pot_text)
        .into_iter()
        .filter(|e| !e.msgid.is_empty())
        .collect();

    let mut old_human: HashMap<PrefillKey, PoEntry> = HashMap::new();
    for e in parse_po(input.old_po_text.unwrap_or("")) {
        if !e.msgid.is_empty() {
            old_human.insert((e.msgid.clone(), e.msgctxt.clone()), e);
        }
    }

    let corpus = build_ru_corpus(input.corpus);
    let mut by_text: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut by_norm: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for ((text, _), variants) in &corpus.map {
        let norm = normalize_text(text);
        let text_set = by_text.entry(text.clone()).or_default();
        let norm_set = by_norm.entry(norm).or_default();
        for v in variants {
            text_set.insert(v.translation.clone());
            norm_set.insert(v.translation.clone());
        }
    }

    let mut report = PrefillReport {
        skipped_with_translation: corpus.skipped_with_translation.clone(),
        ..PrefillReport::default()
    };
    let mut pot_keys: HashSet<PrefillKey> = HashSet::new();
    let mut entries: Vec<PoEntry> = Vec::with_capacity(pot_entries.len());

    for pe in &pot_entries {
        let key: PrefillKey = (pe.msgid.clone(), pe.msgctxt.clone());
        pot_keys.insert(key.clone());
        report.total += 1;

        let variants = corpus.map.get(&key).cloned().unwrap_or_default();
        let distinct: Vec<String> = {
            let set: BTreeSet<String> = variants.iter().map(|v| v.translation.clone()).collect();
            set.into_iter().collect()
        };
        let confirmed = old_human.get(&key);
        let mut out = PoEntry {
            msgid: pe.msgid.clone(),
            msgctxt: pe.msgctxt.clone(),
            refs: pe.refs.clone(),
            comments: pe.comments.clone(),
            translator: confirmed.map(|c| c.translator.clone()).unwrap_or_default(),
            ..PoEntry::default()
        };

        if let Some(c) = confirmed
            .filter(|c| !c.msgstr.is_empty() && !c.flags.iter().any(|f| f == "auto-normalized"))
        {
            // Человек подтвердил (или это точный перенос прошлого прогона).
            out.msgstr = c.msgstr.clone();
            out.flags = c
                .flags
                .iter()
                .filter(|f| *f != "auto-normalized")
                .cloned()
                .collect();
            report.exact += 1;
        } else if distinct.len() > 1 {
            report.conflicts.push((key.clone(), variants.clone()));
        } else if distinct.len() == 1 {
            out.msgstr = distinct[0].clone();
            report.exact += 1;
        } else {
            // Fuzzy: ровно один перевод для голого текста (контекст уехал).
            let cands: Vec<String> = by_text
                .get(&pe.msgid)
                .map(|s| s.iter().cloned().collect())
                .unwrap_or_default();
            if cands.len() == 1 {
                out.msgstr = cands[0].clone();
                out.flags = vec!["fuzzy".to_string()];
                report.fuzzy.push((key.clone(), cands[0].clone()));
            } else {
                // Нормализованный fallback: урезанные FSM-варианты («000 Aw ... 2»)
                // наследуют единственный перевод близнеца, если семейство не в blocklist.
                let norm = normalize_text(&pe.msgid);
                let norm_cands: Vec<String> = by_norm
                    .get(&norm)
                    .map(|s| s.iter().cloned().collect())
                    .unwrap_or_default();
                if norm_cands.len() == 1 && !input.blocked.contains(&norm) {
                    out.msgstr = norm_cands[0].clone();
                    out.flags = vec!["fuzzy".to_string(), "auto-normalized".to_string()];
                    report
                        .auto_normalized
                        .push((key.clone(), norm_cands[0].clone()));
                } else {
                    report.missing.push(key.clone());
                }
            }
        }
        entries.push(out);
    }

    for (key, variants) in &corpus.map {
        if !pot_keys.contains(key) {
            report.orphans.push((key.clone(), variants.clone()));
        }
    }

    (entries, report)
}

/// Строки заголовка ru.po (побайтово как в TS-эталоне; Lang всегда ru).
pub fn ru_header_lines(created: &str) -> Vec<String> {
    vec![
        "# Russian translation for NeonTranslator (migrated from YAML corpus).".to_string(),
        "msgid \"\"".to_string(),
        "msgstr \"\"".to_string(),
        "\"Project-Id-Version: NeonTranslator 1.0\\n\"".to_string(),
        format!("\"PO-Revision-Date: {created}\\n\""),
        "\"Language: ru\\n\"".to_string(),
        "\"Content-Type: text/plain; charset=UTF-8\\n\"".to_string(),
        "\"Content-Transfer-Encoding: 8bit\\n\"".to_string(),
        "\"Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n\"".to_string(),
    ]
}

/// Текущая дата в формате заголовка (`YYYY-MM-DD HH:MM+0000`), UTC.
pub fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    stamp_from_unix(secs)
}

/// Дату из unix-секунд → `YYYY-MM-DD HH:MM+0000` (гражданский календарь, UTC).
pub fn stamp_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}+0000",
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// Дни с 1970-01-01 → (год, месяц, день) по алгоритму Х. Хиннанта.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + i64::from(m <= 2), m, d)
}

#[derive(Debug, Clone)]
pub struct PrefillOptions {
    pub lang: String,
    pub po_dir: PathBuf,
    /// Корень YAML-корпуса; по умолчанию `../translations` от каталога po/.
    pub corpus_dir: Option<PathBuf>,
    /// Фиксированная дата заголовка (паритет/тесты); по умолчанию — сейчас.
    pub created: Option<String>,
}

impl PrefillOptions {
    pub fn new(root: &Path) -> Self {
        Self {
            lang: DEFAULT_LANG.to_string(),
            po_dir: root.join("po"),
            corpus_dir: None,
            created: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PrefillResult {
    pub po_path: PathBuf,
    pub report: PrefillReport,
}

/// Прогон: POT + корпус + текущий PO → новый PO. Ошибка, если POT нет.
pub fn run_prefill(options: &PrefillOptions) -> Result<PrefillResult, String> {
    let po_dir = options.po_dir.clone();
    let pot_path = po_dir.join("template.pot");
    if !pot_path.is_file() {
        return Err("run potgen first (po/template.pot missing)".to_string());
    }
    let corpus_dir = options.corpus_dir.clone().unwrap_or_else(|| {
        po_dir
            .parent()
            .map(|p| p.join("translations"))
            .unwrap_or_else(|| PathBuf::from("translations"))
    });

    let po_path = po_dir.join(format!("{}.po", options.lang));
    let old_po_text = std::fs::read_to_string(&po_path).ok();
    let pot_text =
        std::fs::read_to_string(&pot_path).map_err(|e| format!("{}: {e}", pot_path.display()))?;
    let corpus = iter_source_entries(&corpus_dir);
    let blocked = load_blocklist(&po_dir);

    let (entries, report) = build_ru_po(&BuildRuPoInput {
        pot_text: &pot_text,
        old_po_text: old_po_text.as_deref(),
        corpus: &corpus,
        blocked: &blocked,
    });

    let created = options.created.clone().unwrap_or_else(now_stamp);
    write_atomic(&po_path, &render_po(&entries, &ru_header_lines(&created)))?;
    Ok(PrefillResult { po_path, report })
}

// ---------------------------------------------------------------------------
// Отчёт (stderr): примитивы как в Python — repr, срез, формат .1f.
// ---------------------------------------------------------------------------

/// Срез по code points (Python `s[:n]`), не по UTF-16 units.
pub fn cp_slice(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Приближение `str.isprintable()`: не печатаются Cc/Cf/Co/Cs/Zl/Zp и все Zs,
/// кроме пробела. Полный набор категорий Unicode без зависимости не берём —
/// это текст отчёта, а не данные (паритет гейтит только сам PO).
fn is_py_printable(c: char) -> bool {
    if c == ' ' {
        return true;
    }
    let u = c as u32;
    if c.is_control() || (0x7f..=0x9f).contains(&u) {
        return false;
    }
    let separator = matches!(
        u,
        0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000
    );
    let format = matches!(
        u,
        0xad | 0x600..=0x605
            | 0x61c
            | 0x6dd
            | 0x70f
            | 0x8e2
            | 0x200b..=0x200f
            | 0x202a..=0x202e
            | 0x2060..=0x2064
            | 0x2066..=0x206f
            | 0xfeff
            | 0xfff9..=0xfffb
            | 0x110bd
            | 0x110cd
            | 0x1bca0..=0x1bca3
            | 0x1d173..=0x1d17a
            | 0xe0001
            | 0xe0020..=0xe007f
    );
    let private = (0xe000..=0xf8ff).contains(&u);
    !(separator || format || private)
}

/// `repr(str)` для отчёта: кавычка по содержимому, эскейпы управляющих символов.
pub fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for ch in s.chars() {
        let cp = ch as u32;
        if ch == '\\' {
            out.push_str("\\\\");
        } else if ch == quote {
            out.push('\\');
            out.push(ch);
        } else if ch == '\n' {
            out.push_str("\\n");
        } else if ch == '\r' {
            out.push_str("\\r");
        } else if ch == '\t' {
            out.push_str("\\t");
        } else if cp < 0x20 || cp == 0x7f {
            out.push_str(&format!("\\x{cp:02x}"));
        } else if cp > 0x7e && !is_py_printable(ch) {
            if cp <= 0xff {
                out.push_str(&format!("\\x{cp:x}"));
            } else if cp <= 0xffff {
                out.push_str(&format!("\\u{cp:04x}"));
            } else {
                out.push_str(&format!("\\U{cp:08x}"));
            }
        } else {
            out.push(ch);
        }
    }
    out.push(quote);
    out
}

/// Python `format(x, ".1f")` — округление к ближайшему, полук чётному.
pub fn py_fixed1(x: f64) -> String {
    let scaled = x * 10.0;
    let floor = scaled.floor();
    let diff = scaled - floor;
    let n = if diff > 0.5 || (diff == 0.5 && (floor as i64) % 2 != 0) {
        floor + 1.0
    } else {
        floor
    };
    format!("{:.1}", n / 10.0)
}

/// Python repr списка кортежей `[(tr, file), …]` — как печатает f-string.
pub fn repr_variants(variants: &[RuVariant]) -> String {
    let items: Vec<String> = variants
        .iter()
        .map(|v| format!("({}, {})", py_repr(&v.translation), py_repr(&v.file)))
        .collect();
    format!("[{}]", items.join(", "))
}

/// Отчёт prefill (stderr) — ровно те же секции, что у TS-эталона.
pub fn format_report(lang: &str, po_path: &Path, r: &PrefillReport) -> String {
    let mut out = String::new();
    let cov = py_fixed1(100.0 * r.exact as f64 / r.total.max(1) as f64);
    out.push_str(&format!(
        "{lang}.po: {}/{} exact ({cov}%) -> {}\n",
        r.exact,
        r.total,
        po_path.display()
    ));
    out.push_str(&format!("  fuzzy (context drift): {}\n", r.fuzzy.len()));
    out.push_str(&format!(
        "  auto-normalized (stripped variants inherit): {}\n",
        r.auto_normalized.len()
    ));
    for ((text, ctxt), tr) in r.auto_normalized.iter().take(10) {
        out.push_str(&format!(
            "    AUTO {ctxt} {} -> {}\n",
            py_repr(&cp_slice(text, 60)),
            py_repr(&cp_slice(tr, 60))
        ));
    }
    out.push_str(&format!(
        "  conflicts (same key, different RU): {}\n",
        r.conflicts.len()
    ));
    for ((text, ctxt), variants) in r.conflicts.iter().take(10) {
        out.push_str(&format!("    CONFLICT {ctxt} {}:\n", py_repr(text)));
        for v in variants {
            out.push_str(&format!(
                "      {}  [{}]\n",
                py_repr(&v.translation),
                v.file
            ));
        }
    }
    out.push_str(&format!(
        "  missing (no RU anywhere): {}\n",
        r.missing.len()
    ));
    for (text, ctxt) in r.missing.iter().take(10) {
        out.push_str(&format!(
            "    MISSING {ctxt} {}\n",
            py_repr(&cp_slice(text, 70))
        ));
    }
    out.push_str(&format!(
        "  orphans (RU with no POT entry): {}\n",
        r.orphans.len()
    ));
    for ((text, ctxt), variants) in r.orphans.iter().take(10) {
        out.push_str(&format!(
            "    ORPHAN {ctxt} {}: {}\n",
            py_repr(&cp_slice(text, 70)),
            repr_variants(variants)
        ));
    }
    out.push_str(&format!(
        "  skipped with real translation: {}\n",
        r.skipped_with_translation.len()
    ));
    for s in r.skipped_with_translation.iter().take(10) {
        out.push_str(&format!(
            "    SKIPPED-TR {} {} -> {} [{}]\n",
            s.ctxt,
            py_repr(&cp_slice(&s.text, 50)),
            py_repr(&cp_slice(&s.translation, 50)),
            s.file
        ));
    }
    out
}

/// Ключи отчёта в JSON (полные списки — для аудита миграции).
pub fn report_to_json(r: &PrefillReport) -> String {
    fn key_json(key: &PrefillKey) -> String {
        format!(
            "[{}, {}]",
            rust_l10n_core::json::quoted(&key.0),
            rust_l10n_core::json::quoted(&key.1)
        )
    }
    fn pairs(items: &[(PrefillKey, String)]) -> String {
        let body: Vec<String> = items
            .iter()
            .map(|(k, v)| {
                format!(
                    "{{\"key\": {}, \"value\": {}}}",
                    key_json(k),
                    rust_l10n_core::json::quoted(v)
                )
            })
            .collect();
        format!("[{}]", body.join(", "))
    }
    let mut out = String::from("{");
    out.push_str(&format!("\"total\": {}", r.total));
    out.push_str(&format!(", \"exact\": {}", r.exact));
    out.push_str(&format!(", \"fuzzy\": {}", pairs(&r.fuzzy)));
    out.push_str(&format!(
        ", \"autoNormalized\": {}",
        pairs(&r.auto_normalized)
    ));
    let conflicts: Vec<String> = r
        .conflicts
        .iter()
        .map(|(k, variants)| {
            format!(
                "{{\"key\": {}, \"variants\": {}}}",
                key_json(k),
                repr_variants(variants)
            )
        })
        .collect();
    out.push_str(&format!(", \"conflicts\": [{}]", conflicts.join(", ")));
    let missing: Vec<String> = r.missing.iter().map(key_json).collect();
    out.push_str(&format!(", \"missing\": [{}]", missing.join(", ")));
    let orphans: Vec<String> = r
        .orphans
        .iter()
        .map(|(k, _)| format!("{{\"key\": {}}}", key_json(k)))
        .collect();
    out.push_str(&format!(", \"orphans\": [{}]", orphans.join(", ")));
    out.push_str(&format!(
        ", \"skippedWithTranslation\": {}",
        r.skipped_with_translation.len()
    ));
    out.push('}');
    out.push('\n');
    out
}
