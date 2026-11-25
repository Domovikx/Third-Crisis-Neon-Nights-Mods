import type { GameInfo, UninstallResult } from "@/core/types";
import type { Locale } from "@/i18n";
import { errorText, t } from "@/i18n";
import { Button, Note, Panel, Row } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Uninstall";

export function Uninstall(props: {
  locale: Locale;
  game: GameInfo | null;
  busy: boolean;
  result: UninstallResult | null;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const { locale, game, busy, result, error } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{result ? tr("uninstallDone") : tr("uninstallTitle")}</h1>

      {error ? <Note tone="error">{errorText(locale, error)}</Note> : null}

      {result ? (
        <>
          <Note tone={result.kept.length ? "warn" : "ok"}>
            {tr("uninstallDeleted", { count: result.deleted.length })}
          </Note>
          <Panel testId={`${ROOT}--summary`}>
            <Row label={tr("rowKept")} value={result.kept.length} />
            <Row label={tr("rowDirs")} value={result.removedDirs.length} />
          </Panel>
          <div className={cx(common.field)}>
            <Button variant="primary" onClick={props.onBack} testId={`${ROOT}--back`}>
              {tr("back")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className={cx(common.lead)}>{tr("uninstallBody")}</p>
          {game ? <Row label={tr("gameFolder")} value={game.path} /> : null}
          <div className={cx(common.field)}>
            <Button
              variant="danger"
              onClick={props.onConfirm}
              disabled={busy}
              testId={`${ROOT}--confirm`}
            >
              {tr("uninstallConfirm")}
            </Button>
            <Button
              variant="ghost"
              onClick={props.onCancel}
              disabled={busy}
              testId={`${ROOT}--cancel`}
            >
              {tr("cancel")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
