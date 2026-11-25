// Без консольного окна в релизе.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Невидимые CLI-пути (поддержка и E2E). Реальную игру они не ищут —
    // работают только с явно переданной папкой:
    //   --selftest [payload]     install → status → update → verify → uninstall
    //   --status <game>          статус (версия, язык, целостность)
    //   --verify <game>          сверка установки с манифестом
    //   --uninstall <game>       удалить ровно поставленное
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--selftest") {
        std::process::exit(neon_manager_lib::selftest(args.get(i + 1).cloned()));
    }
    for (flag, handler) in [
        ("--status", neon_manager_lib::cli_status as fn(&str) -> i32),
        ("--verify", neon_manager_lib::cli_verify),
        ("--uninstall", neon_manager_lib::cli_uninstall),
    ] {
        if let Some(i) = args.iter().position(|a| a == flag) {
            match args.get(i + 1) {
                Some(dir) => std::process::exit(handler(dir)),
                None => {
                    eprintln!("{flag} без папки игры");
                    std::process::exit(1);
                }
            }
        }
    }
    neon_manager_lib::run();
}
