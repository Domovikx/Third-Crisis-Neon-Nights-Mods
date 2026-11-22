//! find_source.rs — провенанс: из какого объекта дампа пришёл msgid.
//!
//! Порт `.opencode/skills/extract-text/scripts/find_source.mts` (поведение 1:1).
//! POT/PO не несут `#: refs` (мёртвый вес, ~50 % файла), поэтому источник
//! строки — JSONL-дамп (`inventory::scan_dump`, тот же порядок, что у potgen).
//! Печатает каждое вхождение:
//!
//! ```text
//! [kind:source#idx] speaker=X :: text
//! ```
//!
//! CLI: `rust-l10n find_source "<msgid text>" [--first] [--dump <dir>]
//!       [--root <dir>]`.
//! Exit 1, если ничего не найдено (или дампа нет).

use std::path::{Path, PathBuf};

use crate::inventory::{find_chunks, find_summaries, scan_dump, InventoryItem};

/// Точный скан дампа: все записи с текстом, равным `text`.
pub fn find(text: &str, dump_dir: &Path, first: bool) -> Result<Vec<InventoryItem>, String> {
    let inventory = scan_dump(dump_dir)?;
    let mut hits: Vec<InventoryItem> = Vec::new();
    for item in inventory.items {
        if item.text == text {
            hits.push(item);
            if first {
                break;
            }
        }
    }
    Ok(hits)
}

/// Есть ли в дампе хоть что-то (как `not find_chunks() and not find_summaries()`).
pub fn has_dump(dump_dir: &Path) -> bool {
    if !dump_dir.is_dir() {
        return false;
    }
    find_chunks(dump_dir)
        .map(|c| !c.is_empty())
        .unwrap_or(false)
        || !find_summaries(dump_dir).is_empty()
}

/// Срез по code points (Python `s[:n]`), не по UTF-16 units.
fn cp_slice(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Строка отчёта: `[kind:source#idx] speaker=X :: text[:120]`.
pub fn fmt(item: &InventoryItem) -> String {
    let mut base = format!("{}:{}", item.kind.as_str(), item.source);
    if let Some(idx) = item.idx {
        base.push_str(&format!("#{idx}"));
    }
    let sp = if item.speaker.is_empty() {
        String::new()
    } else {
        format!(" speaker={}", item.speaker)
    };
    format!("[{base}]{sp} :: {}", cp_slice(&item.text, 120))
}

#[derive(Debug, Clone)]
pub struct FindSourceOptions {
    pub text: String,
    pub first: bool,
    pub dump_dir: PathBuf,
}

impl FindSourceOptions {
    pub fn new(root: &Path) -> Self {
        Self {
            text: String::new(),
            first: false,
            dump_dir: root.join("tmp").join("dump"),
        }
    }
}
