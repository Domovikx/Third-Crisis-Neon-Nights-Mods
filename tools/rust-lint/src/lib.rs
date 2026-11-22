//! rust-lint — независимый read-only аудит целостности POT/PO/DAT.
//!
//! Граница: инструмент ничего не правит и не зависит от правил QA/переводчика.
//! PO-парсер общий с пайплайном ([`rust_l10n_core::po`]) — иначе аудит и
//! генератор по-разному видели бы один файл. Всё остальное (экранирование,
//! кодировка, теги, якоря, .dat) проверяется независимо.
//!
//! Результат: `LangAudit` на язык (JSON) + markdown-сводка. Методика,
//! калибровка и найденное — `docs/data-audit.md`.

pub mod audit;
pub mod classes;
pub mod noise;
pub mod report;
pub mod text;

pub use audit::{
    audit_files, audit_pot, audit_strings, audit_strings_opts, Calibration, ClassResult, Finding,
    LangAudit, PotAudit,
};
pub use classes::{Level, Verdict};
