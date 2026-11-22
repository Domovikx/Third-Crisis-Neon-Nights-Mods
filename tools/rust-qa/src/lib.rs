//! rust-qa — Rust-исполнитель QA-контракта `translate-qa` (паритет с TS).
//!
//! Граница: Rust делает чтение PO/JSONL и правила (они целиком детерминированы),
//! TS остаётся эталоном-оракулом и рисует HTML. Решение и цифры —
//! `docs/qa-scaling.md`.

pub mod dat;
pub mod json;
pub mod po;
pub mod report;
pub mod rules;
