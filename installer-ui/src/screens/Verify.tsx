import type { VerifyResult } from "@/core/types";
import type { Locale } from "@/i18n";
import { errorText, t } from "@/i18n";
import { Button, Note, Panel, Row } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Verify";

const MAX_DETAILS = 30;

export function Verify(props: {
  locale: Locale;
  result: VerifyResult | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
}) {
  const { locale, result, busy, error } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);

  const details = result
    ? [...result.missing, ...result.modified.map((item) => item.path), ...result.unlisted]
    : [];

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{tr("verifyTitle")}</h1>

      {error ? <Note tone="error">{errorText(locale, error)}</Note> : null}
      {busy ? <Note>{tr("verifyRunning")}</Note> : null}

      {!busy && result ? (
        <>
          {!result.installed ? (
            <Note tone="warn">{tr("verifyNotInstalled")}</Note>
          ) : result.ok ? (
            <Note tone="ok">{tr("verifyOk", { count: result.checked })}</Note>
          ) : (
            <Note tone="error">{tr("verifyMissing", { count: result.missing.length })}</Note>
          )}

          {result.installed ? (
            <Panel testId={`${ROOT}--summary`}>
              <Row label={tr("rowChecked")} value={result.checked} />
              <Row label={tr("rowModified")} value={result.modified.length} />
              <Row label={tr("rowUnlisted")} value={result.unlisted.length} />
              {result.lang ? <Row label={tr("rowLang")} value={result.lang.toUpperCase()} /> : null}
            </Panel>
          ) : null}

          {details.length ? (
            <ul className={cx(common.details)} data-testid={`${ROOT}--details`}>
              {details.slice(0, MAX_DETAILS).map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <div className={cx(common.field)}>
        <Button variant="primary" onClick={props.onBack} testId={`${ROOT}--back`}>
          {tr("back")}
        </Button>
      </div>
    </div>
  );
}
