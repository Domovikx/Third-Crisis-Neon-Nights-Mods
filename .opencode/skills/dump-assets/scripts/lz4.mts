/**
 * lz4.mts — декодер LZ4 block-формата на чистом TypeScript (без зависимостей).
 *
 * Unity пакует блоки бандлов LZ4/LZ4HC, но на распаковке это ОДИН формат:
 * LZ4HC — тот же block-формат, отличается только стратегией сжатия. Поэтому
 * декодер один. Фрейм-формат (с magic 0x184D2204) не поддерживается: Unity
 * его не использует, а «на всякий случай» его писать — YAGNI.
 *
 * Формат последовательности: token (4 бита литералов | 4 бита длины матча),
 * расширение длины байтами 255+остаток, литералы, offset (2 байта LE),
 * матч. Последняя последовательность — только литералы, без offset.
 */

import { BinaryFormatError } from "./binary.mts";

/**
 * Распаковать LZ4-блок в буфер ровно заданного размера.
 *
 * @param src сжатый блок
 * @param expectedSize ожидаемый размер после распаковки (из заголовка блока)
 */
export function lz4BlockDecompress(src: Uint8Array, expectedSize: number): Uint8Array {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new BinaryFormatError(`LZ4: некорректный ожидаемый размер ${expectedSize}`, 0);
  }
  const dst = new Uint8Array(expectedSize);
  let sp = 0;
  let dp = 0;

  while (sp < src.length) {
    const token = src[sp++];

    // --- литералы ---
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b: number;
      do {
        if (sp >= src.length) throw new BinaryFormatError("LZ4: длина литералов обрывается", sp);
        b = src[sp++];
        litLen += b;
      } while (b === 255);
    }
    if (sp + litLen > src.length) {
      throw new BinaryFormatError(`LZ4: литерал (${litLen} байт) выходит за конец блока`, sp);
    }
    if (dp + litLen > dst.length) {
      throw new BinaryFormatError(
        `LZ4: литералы переполняют выход (${dp + litLen} > ${dst.length})`,
        sp,
      );
    }
    dst.set(src.subarray(sp, sp + litLen), dp);
    sp += litLen;
    dp += litLen;

    // Последняя последовательность — только литералы.
    if (sp >= src.length) break;

    // --- матч ---
    if (sp + 2 > src.length) throw new BinaryFormatError("LZ4: обрезан offset матча", sp);
    const offset = src[sp] | (src[sp + 1] << 8);
    sp += 2;
    if (offset === 0) throw new BinaryFormatError("LZ4: offset матча равен 0", sp - 2);
    if (offset > dp) {
      throw new BinaryFormatError(`LZ4: offset ${offset} больше распакованного окна ${dp}`, sp - 2);
    }

    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b: number;
      do {
        if (sp >= src.length) throw new BinaryFormatError("LZ4: длина матча обрывается", sp);
        b = src[sp++];
        matchLen += b;
      } while (b === 255);
    }
    if (dp + matchLen > dst.length) {
      throw new BinaryFormatError(
        `LZ4: матч переполняет выход (${dp + matchLen} > ${dst.length})`,
        sp,
      );
    }
    // Копирование байт за байтом: матч может перекрывать сам себя.
    let mp = dp - offset;
    for (let i = 0; i < matchLen; i++) dst[dp++] = dst[mp++];
  }

  if (dp !== expectedSize) {
    throw new BinaryFormatError(
      `LZ4: распаковано ${dp} байт вместо ${expectedSize} (блок обрезан или заголовок врёт)`,
      sp,
    );
  }
  return dst;
}
