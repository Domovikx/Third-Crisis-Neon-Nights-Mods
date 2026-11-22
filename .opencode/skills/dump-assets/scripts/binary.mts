/**
 * binary.mts — курсор по байтам для парсеров Unity (UnityFS/SerializedFile).
 *
 * Один класс на весь скилл: LE/BE-числа, строки с нулевым терминатором,
 * выравнивание. Ошибки — `BinaryFormatError` с позицией: при разборе битого
 * файла должно быть видно, ГДЕ парсер споткнулся, а не просто «что-то упало».
 *
 * Замечание о порядке байт: контейнер UnityFS и legacy-префикс заголовка
 * SerializedFile пишутся big-endian, а содержимое SerializedFile — в порядке,
 * указанном флагом (у нашей игры little-endian). Поэтому endian — свойство
 * ридера и меняется на лету.
 */

export type Endian = "le" | "be";

/** Ошибка формата: всегда несёт позицию в разбираемом буфере. */
export class BinaryFormatError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} (смещение ${position})`);
    this.name = "BinaryFormatError";
    this.position = position;
  }
}

export interface ByteReaderOptions {
  /** Начальная позиция (по умолчанию 0). */
  pos?: number;
  /** Начальный порядок байт (по умолчанию little-endian). */
  endian?: Endian;
}

export class ByteReader {
  readonly data: Uint8Array;
  pos: number;
  endian: Endian;
  private readonly view: DataView;

  constructor(data: Uint8Array, opts: ByteReaderOptions = {}) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = opts.pos ?? 0;
    this.endian = opts.endian ?? "le";
  }

  get length(): number {
    return this.data.length;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  fail(message: string): never {
    throw new BinaryFormatError(message, this.pos);
  }

  private need(n: number): void {
    if (this.pos + n > this.data.length) {
      this.fail(`усечённые данные: нужно ${n} байт, осталось ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.data[this.pos++];
  }

  i8(): number {
    const v = this.u8();
    return v > 0x7f ? v - 0x100 : v;
  }

  u16(endian: Endian = this.endian): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, endian === "le");
    this.pos += 2;
    return v;
  }

  i16(endian: Endian = this.endian): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, endian === "le");
    this.pos += 2;
    return v;
  }

  u32(endian: Endian = this.endian): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, endian === "le");
    this.pos += 4;
    return v;
  }

  i32(endian: Endian = this.endian): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, endian === "le");
    this.pos += 4;
    return v;
  }

  u64(endian: Endian = this.endian): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, endian === "le");
    this.pos += 8;
    return v;
  }

  i64(endian: Endian = this.endian): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, endian === "le");
    this.pos += 8;
    return v;
  }

  f32(endian: Endian = this.endian): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, endian === "le");
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Строка UTF-8 до нулевого байта (строки Unity почти всегда ASCII). */
  cstring(maxLength = 32767): string {
    const start = this.pos;
    const limit = Math.min(this.data.length, start + maxLength);
    let end = -1;
    for (let i = start; i < limit; i++) {
      if (this.data[i] === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) this.fail("строка без нулевого терминатора");
    const text = new TextDecoder().decode(this.data.subarray(start, end));
    this.pos = end + 1;
    return text;
  }

  align(alignment = 4): void {
    this.pos += (alignment - (this.pos % alignment)) % alignment;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.data.length) {
      this.fail(`выход за границы буфера: запрошена позиция ${pos}`);
    }
    this.pos = pos;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
}

/** i64 → number с проверкой: молча терять точность нельзя. */
export function i64ToNumber(value: bigint, what: string, position = 0): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new BinaryFormatError(`${what} не влезает в безопасное целое: ${value}`, position);
  }
  return n;
}

/** Первые байты строкой latin1 — для определения сигнатуры файла. */
export function signature(data: Uint8Array, length = 8): string {
  let out = "";
  for (let i = 0; i < Math.min(length, data.length); i++) out += String.fromCharCode(data[i]);
  return out;
}
