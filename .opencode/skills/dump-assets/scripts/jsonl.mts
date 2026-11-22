/**
 * jsonl.mts — запись JSONL в формате Python-эталона.
 *
 * Зачем свой сериализатор, а не `JSON.stringify`:
 *   - `path_id` — 64-битный; в `number` он теряет точность, поэтому пишется
 *     как BigInt-десятичное (Python пишет int без потерь);
 *   - `float` в эталоне печатается через `repr` (`60.0`, `1e-05`);
 *   - разделители — как у `json.dumps` по умолчанию (`, ` и `: `), чтобы
 *     текстовый дифф с Python-дампом был читаемым.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { pyFloatRepr } from "./pystr.mts";
import { PyFloat, RawBytes } from "./typetree.mts";

function quoteString(s: string): string {
  return JSON.stringify(s);
}

function numberToString(value: number): string {
  if (!Number.isFinite(value)) {
    return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
  }
  return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
}

/** Сериализовать значение как `json.dumps(..., ensure_ascii=False)`. */
export function jsonlStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return numberToString(value);
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (value instanceof RawBytes) return quoteString("");
  if (Array.isArray(value)) return `[${value.map(jsonlStringify).join(", ")}]`;
  if (value instanceof Uint8Array) return quoteString("");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    return `{${entries.map(([k, v]) => `${quoteString(k)}: ${jsonlStringify(v)}`).join(", ")}}`;
  }
  return quoteString(String(value));
}

/**
 * Потоковый писатель JSONL: строки уходят на диск пачками по ~1 МБ.
 *
 * Дамп `resources.jsonl` — сотни тысяч строк; собирать их в один массив
 * строк нельзя (память), а `appendFileSync` на каждую строку медленный.
 */
export class JsonlWriter {
  private readonly fd: number;
  private buffer: string[] = [];
  private size = 0;

  constructor(path: string) {
    this.fd = openSync(path, "w");
  }

  write(row: unknown): void {
    const line = jsonlStringify(row);
    this.buffer.push(line);
    this.size += line.length + 1;
    if (this.size >= 1 << 20) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    writeSync(this.fd, `${this.buffer.join("\n")}\n`);
    this.buffer = [];
    this.size = 0;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}
