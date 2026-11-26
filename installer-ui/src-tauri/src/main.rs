// Без консольного окна в релизе.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Невидимые CLI-пути (поддержка и E2E). Реальную игру они не ищут —
    // работают только с явно переданной папкой:
    //   --selftest [payload]     install → status → update → verify → uninstall
    //   --install <game> [lang]  поставить из payload (по умолчанию ru)
    //   --update <game>          обновить установленное из payload
    //   --status <game>          статус (версия, язык, целостность)
    //   --verify <game>          сверка установки с манифестом
    //   --uninstall <game>       удалить ровно поставленное
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--selftest") {
        std::process::exit(neon_manager_lib::selftest(args.get(i + 1).cloned()));
    }
    if let Some(i) = args.iter().position(|a| a == "--install") {
        match args.get(i + 1) {
            Some(dir) => {
                let lang = args.get(i + 2).map(String::as_str).unwrap_or("ru");
                std::process::exit(neon_manager_lib::cli_install(dir, lang));
            }
            None => {
                eprintln!("--install без папки игры");
                std::process::exit(1);
            }
        }
    }
    for (flag, handler) in [
        ("--update", neon_manager_lib::cli_update as fn(&str) -> i32),
        ("--status", neon_manager_lib::cli_status),
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
