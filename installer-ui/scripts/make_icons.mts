/**
 * make_icons.mts — собрать иконки Tauri из одного исходного PNG/JPEG.
 *
 * Один источник (арт от владельца) → `src-tauri/icons/`:
 *   icon.ico                     16/24/32/48/64/128/256 (все — BMP)
 *   32x32.png 128x128.png 128x128@2x.png 256x256.png icon.png (512)
 *
 * Почему руками, а не `tauri icon`: нужен контроль над мелкими размерами
 * (16×16 — рамка съедает глиф, поэтому для 16/24 берётся кадр без рамки) и
 * над составом .ico. Все размеры — BMP-записями (32 bpp): PNG внутри .ico
 * понимает оболочка Windows, но не понимает, например, System.Drawing.Icon
 * (проверено 2026-11-26: 256 через PNG читался как 128), а размер файла —
 * не та величина, на которой тут стоит экономить.
 *
 * CLI:
 *   node installer-ui/scripts/make_icons.mts --src tmp/icon-dx.jpg
 *   node installer-ui/scripts/make_icons.mts --src art.png --out installer-ui/src-tauri/icons
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const DEFAULT_OUT = join(REPO_ROOT, "installer-ui", "src-tauri", "icons");

/** Размеры внутри .ico (Windows shell: Explorer/панель задач/Alt+Tab). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** PNG-набор для Tauri (окно/Linux/иконка приложения). */
export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/**
 * Кадрирование для мелких размеров: внешняя неоновая рамка на 16×16 занимает
 * половину площади и «DX» перестаёт читаться. Берём центр 82 % кадра — рамка
 * уходит в обрез, глиф крупнее.
 */
export const SMALL_CROP_UNTIL = 48;
export const SMALL_CROP_FRACTION = 0.82;

function ffmpegBinary(): string {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
  if (probe.status === 0) return "ffmpeg";
  throw new Error("нужен ffmpeg в PATH");
}

function runFfmpeg(args: string[], maxBuffer = 64 * 1024 * 1024): Buffer {
  const result = spawnSync(ffmpegBinary(), args, {
    windowsHide: true,
    maxBuffer,
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")}: ${result.stderr?.toString().trim()}`);
  }
  return result.stdout;
}

/** Фильтр масштаба: мелкие размеры — с кропом рамки и лёгкой резкостью. */
export function scaleFilter(size: number): string {
  const parts: string[] = [];
  if (size < SMALL_CROP_UNTIL) {
    const crop = SMALL_CROP_FRACTION;
    parts.push(`crop=iw*${crop}:ih*${crop}`);
  }
  parts.push(`scale=${size}:${size}:flags=lanczos+accurate_rnd+full_chroma_int`);
  if (size <= 32) parts.push("unsharp=3:3:0.6:3:3:0.0");
  return parts.join(",");
}

/** PNG указанного размера (буфер). */
export function pngAt(src: string, size: number): Buffer {
  return runFfmpeg([
    "-v",
    "error",
    "-i",
    src,
    "-vf",
    scaleFilter(size),
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-",
  ]);
}

/** Сырой BGRA (top-down, как у ffmpeg) для BMP-записи .ico. */
export function bgraAt(src: string, size: number): Buffer {
  const out = runFfmpeg([
    "-v",
    "error",
    "-i",
    src,
    "-vf",
    scaleFilter(size),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "bgra",
    "-",
  ]);
  const expected = size * size * 4;
  if (out.length !== expected) throw new Error(`BGRA ${size}: ${out.length} != ${expected}`);
  // Фон непрозрачный; альфу выставляем явно, чтобы не ловить 0 из конвертера.
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

/** BMP-запись иконки: BITMAPINFOHEADER + XOR (BGRA, снизу вверх) + AND-маска. */
export function bmpEntry(bgra: Buffer, size: number): Buffer {
  const header = Buffer.alloc(40);
  const xorBytes = size * size * 4;
  const maskRow = Math.floor((size + 31) / 32) * 4;
  const maskBytes = maskRow * size;
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xorBytes + maskBytes, 20); // biSizeImage
  // Остальное (ppm, палитра) — нули.

  const xor = Buffer.alloc(xorBytes);
  for (let y = 0; y < size; y++) {
    bgra.copy(xor, y * size * 4, (size - 1 - y) * size * 4, (size - y) * size * 4);
  }
  // AND-маска: 0 = пиксель виден (альфа в XOR решает).
  return Buffer.concat([header, xor, Buffer.alloc(maskBytes)]);
}

export interface IcoImage {
  size: number;
  /** Готовое PNG-тело (для 256). */
  png?: Buffer;
  /** BGRA top-down (для 16..128). */
  bgra?: Buffer;
}

/** Собрать .ico: заголовок + записи + тела. */
export function buildIco(images: IcoImage[]): Buffer {
  const bodies = images.map((image) => {
    if (image.png) return image.png;
    if (image.bgra) return bmpEntry(image.bgra, image.size);
    throw new Error(`иконка ${image.size}: нет ни png, ни bgra`);
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((image, index) => {
    const at = index * 16;
    dir.writeUInt8(image.size >= 256 ? 0 : image.size, at); // 0 = 256
    dir.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    dir.writeUInt8(0, at + 2); // color count
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // bpp
    dir.writeUInt32LE(bodies[index].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += bodies[index].length;
  });
  return Buffer.concat([header, dir, ...bodies]);
}

export interface IconReport {
  out: string;
  ico: string;
  pngs: string[];
  icoBytes: number;
}

export function makeIcons(src: string, out: string): IconReport {
  if (!existsSync(src)) throw new Error(`нет исходника: ${src}`);
  mkdirSync(out, { recursive: true });

  const pngs: string[] = [];
  for (const size of PNG_SIZES) {
    const path = join(out, `${size}x${size}.png`);
    writeFileSync(path, pngAt(src, size));
    pngs.push(path);
  }
  // Имена, которых ждёт tauri.conf.json (32/128 из набора выше + 2x/иконка).
  writeFileSync(join(out, "128x128@2x.png"), readFileSync(join(out, "256x256.png")));
  writeFileSync(join(out, "icon.png"), readFileSync(join(out, "512x512.png")));

  const images: IcoImage[] = ICO_SIZES.map((size) => ({ size, bgra: bgraAt(src, size) }));
  const ico = join(out, "icon.ico");
  const icoBytes = buildIco(images);
  writeFileSync(ico, icoBytes);
  return { out, ico, pngs, icoBytes: icoBytes.length };
}

const USAGE = `Иконки менеджера из одного исходника

  node installer-ui/scripts/make_icons.mts --src <png|jpg> [--out <папка>]

  --src   исходный арт (квадрат, лучше ≥1024×1024)
  --out   куда писать (по умолчанию installer-ui/src-tauri/icons)
`;

function main(argv: string[]): number {
  let src = "";
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return 0;
    }
    if (arg === "--src") src = argv[++i] ?? "";
    else if (arg.startsWith("--src=")) src = arg.slice("--src=".length);
    else if (arg === "--out") out = resolve(argv[++i] ?? "");
    else if (arg.startsWith("--out=")) out = resolve(arg.slice("--out=".length));
    else throw new Error(`неизвестная опция: ${arg}`);
  }
  if (!src) {
    console.error(USAGE);
    return 1;
  }
  const report = makeIcons(resolve(src), out);
  console.log(`==> иконки: ${report.out}`);
  console.log(`    .ico ${report.icoBytes} байт (${ICO_SIZES.join("/")})`);
  console.log(`    png: ${PNG_SIZES.join("/")}`);
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
