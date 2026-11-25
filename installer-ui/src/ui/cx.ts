import * as stylex from "@stylexjs/stylex";

/**
 * `className` из стилей StyleX одной функцией: StyleX компилирует стили
 * в объекты, порядок наложения задаёт `props`, поэтому конкатенация строк
 * не подходит.
 */
type StyleArg = Readonly<Record<string, unknown>> | false | null | undefined;

export const cx = (...styles: ReadonlyArray<StyleArg>): string => {
  const { className } = stylex.props(...(styles as ReadonlyArray<never>));
  return className ?? "";
};
