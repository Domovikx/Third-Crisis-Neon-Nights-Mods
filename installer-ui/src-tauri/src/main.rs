// Без консольного окна в релизе.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Невидимые CLI-пути (поддержка и E2E). Реальную игру они не ищут —
    // работают только с явно переданной папкой:
    //   --selftest [payload]     установка во временную «игру» → verify → uninstall
    //   --verify <game>          сверка установки с манифестом
    //   --uninstall <game>       удалить ровно поставленное
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--selftest") {
        std::process::exit(neon_installer_lib::selftest(args.get(i + 1).cloned()));
    }
    if let Some(i) = args.iter().position(|a| a == "--verify") {
        match args.get(i + 1) {
            Some(dir) => std::process::exit(neon_installer_lib::cli_verify(dir)),
            None => {
                eprintln!("--verify без папки игры");
                std::process::exit(1);
            }
        }
    }
    if let Some(i) = args.iter().position(|a| a == "--uninstall") {
        match args.get(i + 1) {
            Some(dir) => std::process::exit(neon_installer_lib::cli_uninstall(dir)),
            None => {
                eprintln!("--uninstall без папки игры");
                std::process::exit(1);
            }
        }
    }
    neon_installer_lib::run();
}
