import * as stylex from "@stylexjs/stylex";

/** Общие элементы экранов: заголовки, списки, бейджи. */
export const common = stylex.create({
  stack: { display: "flex", flexDirection: "column", gap: 12 },
  title: { fontSize: 21, fontWeight: 700, margin: 0 },
  sectionTitle: { fontSize: 14.5, fontWeight: 700, margin: 0 },
  lead: { color: "var(--muted)", margin: 0, maxWidth: 720 },
  muted: { color: "var(--muted)", fontSize: 12.5, margin: 0 },
  mono: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 12.5,
    wordBreak: "break-all",
  },
  list: { margin: 0, paddingInlineStart: 20, display: "flex", flexDirection: "column", gap: 6 },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingBlock: 2,
    paddingInline: 10,
    borderRadius: 999,
    border: "1px solid var(--border)",
    fontSize: 12,
    fontWeight: 600,
  },
  badgeOk: { borderColor: "var(--ok)", color: "var(--ok)" },
  badgeWarn: { borderColor: "var(--warn)", color: "var(--warn)" },
  headRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  field: { display: "flex", alignItems: "center", gap: 10, fontSize: 13 },
  details: {
    margin: 0,
    paddingInlineStart: 20,
    maxHeight: 180,
    overflowY: "auto",
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 12,
    wordBreak: "break-all",
  },
});
