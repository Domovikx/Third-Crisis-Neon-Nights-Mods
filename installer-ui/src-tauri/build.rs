fn main() {
    // Tauri вшивает `../dist` в бинарь на этапе компиляции. Без этих строк
    // cargo не знает, что фронтенд пересобрался, и молча оставляет старый UI
    // в exe (поймано 2026-11-25: `npm run build` + `cargo build --release`
    // завершился за 0.35 с). `index.html` меняется при каждой сборке Vite —
    // этого достаточно, чтобы пересборка была гарантированной.
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=../dist/index.html");
    tauri_build::build()
}
