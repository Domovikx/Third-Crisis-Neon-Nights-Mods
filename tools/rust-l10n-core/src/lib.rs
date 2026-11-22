//! rust-l10n-core — общее ядро текстового пайплайна локализации.
//!
//! Один PO-парсер на все Rust-инструменты: QA (`tools/rust-qa`) и генераторы
//! POT/`.dat` (`tools/rust-l10n`). Второй парсер не заводится — иначе их
//! расхождения пришлось бы ловить паритетом между собой, а не с TS-эталоном.
//!
//! Модули:
//! - [`po`] — парсер PO/POT и рендер (1:1 с `.opencode/skills/extract-text/scripts/po_file.mts`);
//! - [`dat`] — чтение `runtime/patch_<lang>.dat` (JSONL, контракт `qa_translate.mts::loadDat`);
//! - [`json`] — писатель JSON, побайтово совместимый с `JSON.stringify`.
//!
//! Границы и цифры: `docs/language-audit.md`, задача `tasks/2026-11-22-rust-text-core.md`.

pub mod dat;
pub mod json;
pub mod po;
