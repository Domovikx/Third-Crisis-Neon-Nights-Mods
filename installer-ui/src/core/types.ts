/**
 * Контракт с Rust-бэкендом (`installer-ui/core` + `src-tauri`).
 * Поля — camelCase: serde переименовывает в snake_case на стороне Rust.
 */

export interface GameInfo {
  path: string;
  library: string;
  buildId: string | null;
  modInstalled: boolean;
  installedLang: string | null;
}

export interface GameCheck {
  dir: string | null;
  ok: boolean;
  missing: string[];
}

export interface ProbeResult {
  check: GameCheck;
  game: GameInfo | null;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface InstallResult {
  lang: string;
  payloadVersion: string | null;
  files: ManifestFile[];
  copied: number;
  bytes: number;
  manifestPath: string;
  removedStale: string[];
}

export interface UninstallResult {
  deleted: string[];
  kept: string[];
  removedDirs: string[];
  manifestDeleted: boolean;
}

export interface VerifyMismatch {
  path: string;
  expected: string;
  actual: string | null;
}

export interface VerifyResult {
  installed: boolean;
  ok: boolean;
  checked: number;
  lang: string | null;
  missing: string[];
  modified: VerifyMismatch[];
  invalid: string[];
  unlisted: string[];
}

export interface InstallProgress {
  done: number;
  total: number;
  path: string;
}

export interface PayloadStatus {
  dir: string;
  exists: boolean;
  version: string | null;
  langs: string[];
}

/** Транспорт: Tauri-команды или мок для dev/тестов. */
export interface InstallerPlatform {
  kind: "tauri" | "mock";
  systemLocale(): Promise<string>;
  detectGame(): Promise<GameInfo | null>;
  probeGame(path: string): Promise<ProbeResult>;
  chooseFolder(): Promise<string | null>;
  payloadStatus(): Promise<PayloadStatus>;
  install(args: { gameDir: string; lang: string }): Promise<InstallResult>;
  uninstall(gameDir: string): Promise<UninstallResult>;
  verify(gameDir: string): Promise<VerifyResult>;
  /** Подписка на прогресс установки; возвращает функцию отписки. */
  onProgress(callback: (progress: InstallProgress) => void): () => void;
}
