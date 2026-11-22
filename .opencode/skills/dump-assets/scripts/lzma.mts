/**
 * lzma.mts — декодер LZMA1 (raw-поток без .lzma-заголовка) на чистом TS.
 *
 * Это ФОЛБЭК для бандлов, сжатых LZMA (у Third Crisis Neon Nights все бандлы
 * LZ4HC). Внешние распаковщики не нужны: алгоритм реализован здесь, чтобы
 * парсер контейнера оставался на TypeScript.
 *
 * Unity кладёт поток как у xz: 1 байт свойств (lc/lp/pb), 4 байта dictSize
 * (little-endian), далее range-coded данные. Размер результата известен из
 * заголовка блока, поэтому декодируем ровно его (end-marker тоже понимаем).
 *
 * Реализация следует референсной схеме LZMA SDK: range decoder,
 * probability-модели литералов/длин/дистанций, состояния (12) и повторы
 * rep0..rep3. Словарь не аллоцируем отдельно — весь выход и есть словарь,
 * дистанции проверяются по уже распакованным байтам.
 */

import { BinaryFormatError } from "./binary.mts";

const PROB_INIT = 1 << 10; // kBitModelTotal / 2
const PROB_TOTAL = 1 << 11;
const MOVE_BITS = 5;

const NUM_STATES = 12;
const POS_STATES_MAX = 16;
const POS_STATE_BITS_MAX = 4;
const LEN_TO_POS_STATES = 4;
const POS_SLOT_BITS = 6;
const START_POS_MODEL_INDEX = 4;
const END_POS_MODEL_INDEX = 14;
const ALIGN_BITS = 4;
const ALIGN_SIZE = 1 << ALIGN_BITS;
const MATCH_MIN_LEN = 2;

/** Range decoder LZMA: вероятности — 11-битные счётчики в Uint16Array. */
class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private pos: number;
  private readonly src: Uint8Array;

  constructor(src: Uint8Array, start: number) {
    this.src = src;
    if (start + 5 > src.length)
      throw new BinaryFormatError("LZMA: обрезан заголовок потока", start);
    if (src[start] !== 0) {
      throw new BinaryFormatError("LZMA: первый байт потока должен быть 0", start);
    }
    this.pos = start + 1;
    this.code =
      ((src[this.pos] << 24) |
        (src[this.pos + 1] << 16) |
        (src[this.pos + 2] << 8) |
        src[this.pos + 3]) >>>
      0;
    this.pos += 4;
  }

  private normalize(): void {
    if (this.range < 0x01000000) {
      if (this.pos >= this.src.length) {
        throw new BinaryFormatError("LZMA: поток оборвался посреди нормализации", this.pos);
      }
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.src[this.pos++]) >>> 0;
    }
  }

  bit(probs: Uint16Array, index: number): number {
    const bound = (this.range >>> 11) * probs[index];
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[index] += (PROB_TOTAL - probs[index]) >> MOVE_BITS;
      bit = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[index] -= probs[index] >> MOVE_BITS;
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  /** Обычное битовое дерево (MSB-first): возвращает numBits-битный символ. */
  tree(probs: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) | this.bit(probs, offset + m);
    return m - (1 << numBits);
  }

  /** Обратное битовое дерево (LSB-first) — для дистанций и align. */
  reverseTree(probs: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = this.bit(probs, offset + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }

  directBits(numBits: number): number {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      this.normalize();
      result = result * 2 + bit;
    }
    return result;
  }
}

/** Модель длины матча (low/mid/high), как в LZMA SDK. */
class LengthDecoder {
  private readonly choice = new Uint16Array(2).fill(PROB_INIT);
  private readonly low = new Uint16Array(POS_STATES_MAX * 8).fill(PROB_INIT);
  private readonly mid = new Uint16Array(POS_STATES_MAX * 8).fill(PROB_INIT);
  private readonly high = new Uint16Array(1 << 8).fill(PROB_INIT);
  private readonly rc: RangeDecoder;

  constructor(rc: RangeDecoder) {
    this.rc = rc;
  }

  decode(posState: number): number {
    if (this.rc.bit(this.choice, 0) === 0) return this.rc.tree(this.low, posState * 8, 3);
    if (this.rc.bit(this.choice, 1) === 0) return 8 + this.rc.tree(this.mid, posState * 8, 3);
    return 16 + this.rc.tree(this.high, 0, 8);
  }
}

/** Длина кодируется со смещением: реальная длина = decode() + MATCH_MIN_LEN. */
function lenToPosState(len: number): number {
  return len < LEN_TO_POS_STATES ? len : LEN_TO_POS_STATES - 1;
}

/**
 * Распаковать raw LZMA1-поток (свойства Unity: props + dictSize + данные).
 *
 * @param src поток с 5-байтовым заголовком свойств
 * @param expectedSize ожидаемый размер результата (из заголовка блока)
 */
export function lzmaRawDecompress(src: Uint8Array, expectedSize: number): Uint8Array {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new BinaryFormatError(`LZMA: некорректный ожидаемый размер ${expectedSize}`, 0);
  }
  if (src.length < 5) throw new BinaryFormatError("LZMA: заголовок свойств обрезан", 0);

  const props = src[0];
  if (props >= 9 * 5 * 5)
    throw new BinaryFormatError(`LZMA: битые свойства 0x${props.toString(16)}`, 0);
  const lc = props % 9;
  const rest = Math.floor(props / 9);
  const lp = rest % 5;
  const pb = Math.floor(rest / 5);

  const posMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  const out = new Uint8Array(expectedSize);
  const literalProbs = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);

  const isMatch = new Uint16Array(NUM_STATES << POS_STATE_BITS_MAX).fill(PROB_INIT);
  const isRep = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG0 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG1 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG2 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRep0Long = new Uint16Array(NUM_STATES << POS_STATE_BITS_MAX).fill(PROB_INIT);
  const posSlotProbs = new Uint16Array(LEN_TO_POS_STATES << POS_SLOT_BITS).fill(PROB_INIT);
  const specPosProbs = new Uint16Array(1 << (END_POS_MODEL_INDEX >> 1)).fill(PROB_INIT);
  const alignProbs = new Uint16Array(ALIGN_SIZE).fill(PROB_INIT);

  const rc = new RangeDecoder(src, 5);
  const lenDecoder = new LengthDecoder(rc);
  const repLenDecoder = new LengthDecoder(rc);

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let outPos = 0;

  while (outPos < expectedSize) {
    const posState = outPos & posMask;
    if (rc.bit(isMatch, (state << POS_STATE_BITS_MAX) + posState) === 0) {
      // --- литерал ---
      const prevByte = outPos > 0 ? out[outPos - 1] : 0;
      const context = ((outPos & lpMask) << lc) + (prevByte >> (8 - lc));
      const base = context * 0x300;
      let symbol = 1;
      if (state < 7) {
        while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literalProbs, base + symbol);
      } else {
        // «Матчевый» литерал: после матча предсказываем по соответствующему байту.
        if (rep0 >= outPos) throw new BinaryFormatError("LZMA: rep0 за пределами словаря", 0);
        let matchByte = out[outPos - rep0 - 1];
        for (;;) {
          const matchBit = (matchByte >> 7) & 1;
          matchByte = (matchByte << 1) & 0xff;
          const bit = rc.bit(literalProbs, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit || symbol >= 0x100) break;
        }
        while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literalProbs, base + symbol);
      }
      out[outPos++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len: number;
    if (rc.bit(isRep, state) !== 0) {
      // --- повтор одного из прошлых расстояний ---
      if (outPos === 0) throw new BinaryFormatError("LZMA: повтор расстояния в начале потока", 0);
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << POS_STATE_BITS_MAX) + posState) === 0) {
          // короткий повтор длиной 1
          state = state < 7 ? 9 : 11;
          if (rep0 >= outPos) throw new BinaryFormatError("LZMA: rep0 за пределами словаря", 0);
          out[outPos] = out[outPos - rep0 - 1];
          outPos += 1;
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (rc.bit(isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDecoder.decode(posState);
      state = state < 7 ? 8 : 11;
    } else {
      // --- новый матч ---
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDecoder.decode(posState);
      state = state < 7 ? 7 : 10;

      const posSlot = rc.tree(posSlotProbs, lenToPosState(len) << POS_SLOT_BITS, POS_SLOT_BITS);
      if (posSlot < START_POS_MODEL_INDEX) {
        rep0 = posSlot;
      } else {
        const numDirectBits = (posSlot >> 1) - 1;
        rep0 = (2 | (posSlot & 1)) << numDirectBits;
        if (posSlot < END_POS_MODEL_INDEX) {
          rep0 += rc.reverseTree(specPosProbs, rep0 - posSlot - 1, numDirectBits);
        } else {
          rep0 += rc.directBits(numDirectBits - ALIGN_BITS) << ALIGN_BITS;
          rep0 += rc.reverseTree(alignProbs, 0, ALIGN_BITS);
          if (rep0 === 0xffffffff) {
            // end-marker: поток закончился раньше заявленного размера
            if (outPos !== expectedSize) {
              throw new BinaryFormatError(
                `LZMA: end-marker на ${outPos} байте, ожидалось ${expectedSize}`,
                0,
              );
            }
            break;
          }
        }
      }
    }

    len += MATCH_MIN_LEN;
    if (rep0 >= outPos) {
      throw new BinaryFormatError(`LZMA: дистанция ${rep0} больше словаря ${outPos}`, 0);
    }
    if (outPos + len > expectedSize) {
      throw new BinaryFormatError(
        `LZMA: матч переполняет выход (${outPos + len} > ${expectedSize})`,
        0,
      );
    }
    for (let i = 0; i < len; i++) {
      out[outPos] = out[outPos - rep0 - 1];
      outPos += 1;
    }
  }

  return out;
}
