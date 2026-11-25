import { installPercent } from "@/core/flow";
import type { InstallProgress } from "@/core/types";
import type { Locale } from "@/i18n";
import { errorText, t } from "@/i18n";
import { shortPath } from "@/core/format";
import { Button, Note, Panel, ProgressBar } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Installing";

export function Installing(props: {
  locale: Locale;
  progress: InstallProgress | null;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const { locale, progress, error } = props;
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);
  const percent = installPercent(progress);

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{tr("installingTitle")}</h1>
      <Panel>
        <ProgressBar value={percent} />
        <div className={cx(common.headRow)}>
          <span className={cx(common.muted)}>
            {progress
              ? t(locale, "installingFile", {
                  done: progress.done,
                  total: progress.total,
                  path: shortPath(progress.path, 48),
                })
              : tr("installingTitle")}
          </span>
          <span className={cx(common.muted)}>{percent}%</span>
        </div>
        <p className={cx(common.muted)}>{tr("installingNote")}</p>
      </Panel>

      {error ? (
        <>
          <Note tone="error">
            {tr("installFailed")} — {errorText(locale, error)}
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
