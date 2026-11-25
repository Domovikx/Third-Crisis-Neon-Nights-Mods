/**
 * Unit-тесты чистого ядра шрифтовой логики (`source/NeonFontCore.cs`).
 *
 * Файл без зависимостей от Unity компилируется настоящим `csc.exe` вместе с
 * мини-харнессом и запускается: проверяются свойства подбора кегля (никогда не
 * растёт, никогда ниже 60 %, влезает в ширину, если это возможно физически) и
 * цепочка fallback-шрифтов по языкам. Это не «пересказ формулы на TS», а
 * прогон того же кода, что уходит в игру.
 *
 * Без `csc.exe` (CI на Linux) тест пропускается: сборка рантайма и там не
 * проверяется (нужны DLL установленной игры, см. AGENTS.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { cscCandidates, chooseCsc } from "../scripts/build.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const CORE = resolve(import.meta.dirname, "..", "source", "NeonFontCore.cs");

const HARNESS = `using System;
using NeonTranslatorDX;

public static class NeonCoreHarness
{
    private static int _fails;

    private static void Check(bool ok, string what)
    {
        if (ok) return;
        _fails++;
        Console.WriteLine("FAIL: " + what);
    }

    public static int Main()
    {
        // --- FitSize: properties over a grid, not a copy of the formula ----
        float[] preferred = { 0f, 10f, 100f, 388f, 413f, 1024f, 5000f };
        float[] available = { 0f, 100f, 388f, 800f };
        int[] sizes = { 1, 12, 36, 64, 120 };
        foreach (float p in preferred)
        foreach (float a in available)
        foreach (int s in sizes)
        {
            int min = NeonFontCore.MinSize(s);
            int r = NeonFontCore.FitSize(p, a, s, min);
            Check(r >= 1, "size>=1 for p=" + p + " a=" + a + " s=" + s + " -> " + r);
            Check(r <= s, "never grows p=" + p + " a=" + a + " s=" + s + " -> " + r);
            Check(r >= min, "never below floor p=" + p + " a=" + a + " s=" + s + " -> " + r);
            Check(min <= s, "floor never above authored size");
            if (p > 0f && a > 0f && r > min)
            {
                double scaled = p * r / s;
                Check(scaled <= a * NeonFontCore.SafeWidth + 0.01,
                    "fits when > floor p=" + p + " a=" + a + " s=" + s + " -> " + r);
            }
        }

        // --- FitSize: the observed menu case --------------------------------
        Check(NeonFontCore.FitSize(413f, 388f, 36, NeonFontCore.MinSize(36)) == 32,
            "menu: 413px at 36pt into 388px -> 32");
        Check(NeonFontCore.FitSize(300f, 388f, 36, NeonFontCore.MinSize(36)) == 36,
            "menu: fits -> untouched");
        Check(NeonFontCore.FitSize(5000f, 100f, 20, NeonFontCore.MinSize(20)) == 12,
            "menu: insane width -> clamped to 60%");

        // --- typography scale: CJK gets more room, Latin stays -----------------
        Check(NeonFontCore.ScaleFor("zh") == 1.08f, "zh scale 1.08");
        Check(NeonFontCore.ScaleFor("ja") == 1.07f, "ja scale 1.07");
        Check(NeonFontCore.ScaleFor("ko") == 1.04f, "ko scale 1.04");
        Check(NeonFontCore.ScaleFor("ru") == 1f, "ru scale 1.00");
        Check(NeonFontCore.LineHeightFor("zh") == 1.6f, "zh line 1.6");
        Check(NeonFontCore.LineHeightFor("ja") == 1.5f, "ja line 1.5");
        Check(NeonFontCore.LineHeightFor("ko") == 1.5f, "ko line 1.5");
        Check(NeonFontCore.LineHeightFor("de") == 1f, "de line 1.0");
        Check(NeonFontCore.ScaledSize(36, 1.08f) == 39, "zh 36 -> 39");
        Check(NeonFontCore.ScaledSize(36, 1.07f) == 39, "ja 36 -> 39");
        Check(NeonFontCore.ScaledSize(36, 1.04f) == 37, "ko 36 -> 37");
        Check(NeonFontCore.ScaledSize(36, 1f) == 36, "ru 36 -> 36");

        // --- language -> face -------------------------------------------------
        Check(NeonFontCore.FaceKeyForLang("ru") == "lat", "ru -> latin face");
        Check(NeonFontCore.FaceKeyForLang("uk") == "lat", "uk -> latin face");
        Check(NeonFontCore.FaceKeyForLang("zh") == "zh", "zh -> zh face");
        Check(NeonFontCore.FaceKeyForLang("ja") == "ja", "ja -> ja face");
        Check(NeonFontCore.FaceKeyForLang("ko") == "ko", "ko -> ko face");

        // --- fallback chain: lat -> SC -> JP -> KR -> marks -------------------
        string[] latin = NeonFontCore.FallbackOrder("ru");
        Check(string.Join(",", latin) == "lat,zh,ja,ko,marks", "latin chain order");
        Check(string.Join(",", NeonFontCore.FallbackOrder("zh")) == "zh,lat,ja,ko,marks", "zh chain order");
        Check(string.Join(",", NeonFontCore.FallbackOrder("ja")) == "ja,lat,zh,ko,marks", "ja chain order");
        Check(string.Join(",", NeonFontCore.FallbackOrder("ko")) == "ko,lat,zh,ja,marks", "ko chain order");
        foreach (string lang in new[] { "en", "ru", "de", "zh", "ja", "ko" })
        {
            string[] order = NeonFontCore.FallbackOrder(lang);
            Check(order.Length == 5, lang + ": five faces in the chain");
            Check(order[0] == NeonFontCore.FaceKeyForLang(lang), lang + ": own face first");
            Check(order[order.Length - 1] == "marks", lang + ": marks last");
            for (int i = 0; i < order.Length; i++)
                for (int j = i + 1; j < order.Length; j++)
                    Check(order[i] != order[j], lang + ": no duplicates");
        }

        Console.WriteLine(_fails == 0 ? "OK" : "FAILED " + _fails);
        return _fails == 0 ? 0 : 1;
    }
}
`;

test("NeonFontCore: fit rule + fallback chain (compiled C#)", (t) => {
  const csc = chooseCsc(cscCandidates());
  if (!csc || !existsSync(CORE)) {
    t.skip("csc.exe недоступен (CI без Windows/.NET Framework)");
    return;
  }
  const dir = mkdtempSync(join(REPO, "tmp", "neoncore-"));
  try {
    const harness = join(dir, "Harness.cs");
    const exe = join(dir, "neoncore.exe");
    writeFileSync(harness, HARNESS);
    const compile = spawnSync(
      csc,
      ["/nologo", "/target:exe", `/out:${exe}`, CORE, harness],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(compile.status, 0, `csc: ${compile.stdout ?? ""}${compile.stderr ?? ""}`);
    const run = spawnSync(exe, [], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, `harness: ${run.stdout ?? ""}${run.stderr ?? ""}`);
    assert.match(run.stdout ?? "", /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
