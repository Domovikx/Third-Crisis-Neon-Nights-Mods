#![allow(dead_code)]

//! Фикстура: временная раскладка `<root>/{po,runtime}` (чистится на Drop).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static SEQ: AtomicUsize = AtomicUsize::new(0);

pub struct Fixture {
    pub root: PathBuf,
}

impl Fixture {
    pub fn new(name: &str) -> Self {
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("rust-qa-test-{}-{seq}-{name}", std::process::id()));
        fs::create_dir_all(root.join("po")).expect("каталог po");
        fs::create_dir_all(root.join("runtime")).expect("каталог runtime");
        Self { root }
    }

    pub fn pot(self, text: &str) -> Self {
        fs::write(self.root.join("po/template.pot"), text).expect("запись POT");
        self
    }

    pub fn po(self, lang: &str, text: &str) -> Self {
        fs::write(self.root.join(format!("po/{lang}.po")), text).expect("запись PO");
        self
    }

    pub fn dat(self, lang: &str, text: &str) -> Self {
        fs::write(self.root.join(format!("runtime/patch_{lang}.dat")), text).expect("запись DAT");
        self
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
