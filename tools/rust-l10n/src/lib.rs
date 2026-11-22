//! rust-l10n — текстовый пайплайн POT/`.dat` на общем PO-крейте.
//!
//! Библиотека нужна тестам (порты TS-тестов и паритетные фикстуры) и бинарю
//! `rust-l10n` с подкомандами `potgen` / `po2dat` / `po_update`.
//!
//! Граница и цифры: `docs/language-audit.md`, задачи
//! `tasks/2026-11-22-rust-text-core.md` и `tasks/2026-11-22-rust-po-update.md`.

pub mod find_source;
pub mod inventory;
pub mod po2dat;
pub mod po_update;
pub mod potgen;
pub mod prefill;
pub mod refs;
pub mod text_filters;
