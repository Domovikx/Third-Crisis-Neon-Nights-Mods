import { installPercent } from "@/core/flow";
import type { InstallProgress, ModOperation } from "@/core/types";
import { shortPath } from "@/core/format";
import type { Locale } from "@/i18n";
import { errorText, t } from "@/i18n";
import { Button, Note, Panel, ProgressBar } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Progress";

export function Progress(props: {
  locale: Locale;
  op: ModOperation | null;
  progress: InstallProgress | null;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const { locale, op, progress, error } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);
  const percent = installPercent(progress);
  const title = op === "update" ? tr("opUpdateTitle") : tr("opInstallTitle");

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{title}</h1>
      <Panel>
        <ProgressBar value={percent} />
        <div className={cx(common.headRow)}>
          <span className={cx(common.muted)}>
            {progress
              ? tr("progressFile", {
                  done: progress.done,
                  total: progress.total,
                  path: shortPath(progress.path, 48),
                })
              : title}
          </span>
          <span className={cx(common.muted)}>{percent}%</span>
        </div>
        <p className={cx(common.muted)}>{tr("progressNote")}</p>
      </Panel>

      {error ? (
        <>
          <Note tone="error">
            {tr("opFailed")} — {errorText(locale, error)}
          </Note>
          <div className={cx(common.field)}>
            <Button variant="primary" onClick={props.onRetry} testId={`${ROOT}--retry`}>
              {tr("retry")}
            </Button>
            <Button variant="ghost" onClick={props.onBack} testId={`${ROOT}--back`}>
              {tr("back")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
