import { formatBytes } from "@/core/format";
import type { InstallResult } from "@/core/types";
import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import { Button, Note, Panel, Row } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Done";

export function Done(props: {
  locale: Locale;
  result: InstallResult | null;
  onVerify: () => void;
  onClose: () => void;
}) {
  const { locale, result } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{tr("doneTitle")}</h1>
      <Note tone="ok">{tr("doneBody")}</Note>

      {result ? (
        <Panel testId={`${ROOT}--summary`}>
          <Row label={tr("rowFiles")} value={result.copied} />
          <Row label={tr("rowSize")} value={formatBytes(result.bytes)} />
          <Row label={tr("rowLang")} value={result.lang.toUpperCase()} />
          {result.removedStale.length ? (
            <Row label={tr("rowStale")} value={result.removedStale.length} />
          ) : null}
        </Panel>
      ) : null}

      <div className={cx(common.field)}>
        <Button variant="primary" onClick={props.onVerify} testId={`${ROOT}--verify`}>
          {tr("doneVerify")}
        </Button>
        <Button variant="ghost" onClick={props.onClose} testId={`${ROOT}--close`}>
          {tr("doneClose")}
        </Button>
      </div>
    </div>
  );
}
