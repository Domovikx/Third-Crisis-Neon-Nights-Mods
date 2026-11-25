import type { GameInfo, PayloadStatus } from "@/core/types";
import type { Locale } from "@/i18n";
import { errorText, t } from "@/i18n";
import { Button, Note, Panel, Row } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Detect";

const EXE = "Third Crisis Neon Nights.exe";

export function Detect(props: {
  locale: Locale;
  game: GameInfo | null;
  detecting: boolean;
  folderError: string | null;
  folderMissing: string[];
  payload: PayloadStatus | null;
  busy: boolean;
  error: string | null;
  onChooseFolder: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  onVerify: () => void;
}) {
  const { locale, game, detecting, payload, busy } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{tr("detectTitle")}</h1>

      {props.error ? <Note tone="error">{errorText(locale, props.error)}</Note> : null}

      {detecting ? <Note>{tr("detectSearching")}</Note> : null}

      {!detecting && game ? (
        <Panel testId={`${ROOT}--found`}>
          <div className={cx(common.headRow)}>
            <h2 className={cx(common.sectionTitle)}>{tr("gameFound")}</h2>
            <span
              className={cx(common.badge, game.modInstalled ? common.badgeOk : common.badgeWarn)}
            >
              {game.modInstalled ? tr("modInstalled") : tr("modNotInstalled")}
            </span>
          </div>

          <Row label={tr("gameFolder")} value={game.path} />
          <Row label={tr("steamBuild")} value={game.buildId ?? "—"} />
          {game.modInstalled ? (
            <Row
              label={tr("rowLang")}
              value={game.installedLang ? game.installedLang.toUpperCase() : "—"}
            />
          ) : null}

          {payload && !payload.exists ? <Note tone="warn">{tr("payloadMissing")}</Note> : null}

          <div className={cx(common.headRow)}>
            <div />
            <div className={cx(common.field)}>
              <Button
                variant="primary"
                onClick={props.onInstall}
                disabled={!payload?.exists || busy}
                testId={`${ROOT}--install`}
              >
                {game.modInstalled ? tr("update") : tr("install")}
              </Button>
              <Button onClick={props.onVerify} disabled={busy} testId={`${ROOT}--verify`}>
                {tr("verify")}
              </Button>
              {game.modInstalled ? (
                <Button
                  variant="danger"
                  onClick={props.onUninstall}
                  disabled={busy}
                  testId={`${ROOT}--uninstall`}
                >
                  {tr("uninstall")}
                </Button>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}

      {!detecting && !game ? (
        <Panel testId={`${ROOT}--not-found`}>
          <h2 className={cx(common.sectionTitle)}>{tr("gameNotFound")}</h2>
          <p className={cx(common.lead)}>{tr("notFoundBody", { exe: EXE })}</p>
          {props.folderError ? (
            <Note tone="warn">
              {props.folderMissing.length
                ? tr("folderInvalid", { missing: props.folderMissing.join(", ") })
                : errorText(locale, props.folderError)}
            </Note>
          ) : null}
          <div>
            <Button
              variant="primary"
              onClick={props.onChooseFolder}
              disabled={busy}
              testId={`${ROOT}--choose`}
            >
              {tr("chooseFolder")}
            </Button>
          </div>
          {payload && !payload.exists ? <Note tone="warn">{tr("payloadMissing")}</Note> : null}
        </Panel>
      ) : null}
    </div>
  );
}
