//! rust-qa — Rust-исполнитель QA-контракта `translate-qa` (паритет с TS).
//!
//! Граница: Rust делает чтение PO/JSONL и правила (они целиком детерминированы),
//! TS остаётся эталоном-оракулом и рисует HTML. Решение и цифры —
//! `docs/qa-scaling.md`.
//!
//! PO/`.dat`/JSON здесь не свои: они вынесены в общий крейт
//! [`rust_l10n_core`] (`tools/rust-l10n-core`), чтобы у пайплайна был ОДИН
//! парсер PO — им пользуются и QA, и генераторы POT/`.dat`.

pub use rust_l10n_core::{dat, json, po};

pub mod report;
pub mod rules;
