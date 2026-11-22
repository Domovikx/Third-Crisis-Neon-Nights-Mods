//! rust-l10n — текстовый пайплайн POT/`.dat` на общем PO-крейте.
//!
//! Библиотека нужна тестам (порты TS-тестов и паритетные фикстуры) и бинарю
//! `rust-l10n` с подкомандами `potgen` / `po2dat`.
//!
//! Граница и цифры: `docs/language-audit.md`, `tasks/2026-11-22-rust-text-core.md`.

pub mod inventory;
pub mod po2dat;
pub mod potgen;
pub mod text_filters;
