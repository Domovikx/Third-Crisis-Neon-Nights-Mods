import { formatBytes } from "@/core/format";
import type { InstallResult, ModOperation } from "@/core/types";
import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import { Button, Note, Panel, Row } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Done";

export function Done(props: {
  locale: Locale;
  op: ModOperation | null;
  result: InstallResult | null;
  onVerify: () => void;
  onBack: () => void;
}) {
  const { locale, op, result } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);
  const title = op === "update" ? tr("doneUpdateTitle") : tr("doneInstallTitle");

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{title}</h1>
      <Note tone="ok">{tr("doneBody")}</Note>

      {result ? (
        <Panel testId={`${ROOT}--summary`}>
          <Row label={tr("doneCopied")} value={result.copied} />
          <Row label={tr("doneSkipped")} value={result.skipped} />
          {result.removedStale.length ? (
            <Row label={tr("doneRemoved")} value={result.removedStale.length} />
          ) : null}
          <Row label={tr("doneSize")} value={formatBytes(result.bytes)} />
          <Row label={tr("doneVersion")} value={result.payloadVersion ?? "—"} />
        </Panel>
      ) : null}

      <div className={cx(common.field)}>
        <Button variant="primary" onClick={props.onVerify} testId={`${ROOT}--verify`}>
          {tr("doneVerify")}
        </Button>
        <Button variant="ghost" onClick={props.onBack} testId={`${ROOT}--back`}>
          {tr("doneBack")}
        </Button>
      </div>
    </div>
  );
}
