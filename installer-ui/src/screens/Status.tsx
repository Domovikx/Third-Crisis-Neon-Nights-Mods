import type { GameInfo, PayloadStatus, StatusResult } from "@/core/types";
import type { Locale } from "@/i18n";
import { errorText, t } from "@/i18n";
import { updateAvailable } from "@/core/flow";
import { Button, Note, Panel, Row } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Status";

const EXE = "Third Crisis Neon Nights.exe";

function IntegrityNote(props: { locale: Locale; status: StatusResult }) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(props.locale, key, vars);
  const { state, missing, modified } = props.status.integrity;
  const text =
    state === "ok"
      ? tr("integrityOk")
      : state === "missing"
        ? tr("integrityMissing", { count: missing })
        : state === "modified"
          ? tr("integrityModified", { count: modified })
          : state === "broken"
            ? tr("integrityBroken")
            : tr("integrityUnknown");
  const tone =
    state === "ok" ? "ok" : state === "unknown" ? "info" : state === "broken" ? "error" : "warn";
  return <Note tone={tone}>{`${tr("integrityLabel")}: ${text}`}</Note>;
}

export function Status(props: {
  locale: Locale;
  game: GameInfo | null;
  status: StatusResult | null;
  payload: PayloadStatus | null;
  detecting: boolean;
  folderError: string | null;
  folderMissing: string[];
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onChooseFolder: () => void;
  onInstall: () => void;
  onUpdate: () => void;
  onVerify: () => void;
  onUninstall: () => void;
}) {
  const { locale, game, status, payload, detecting, busy } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);
  const installed = Boolean(status?.installed);
  const hasUpdate = updateAvailable({ status, payload });
  const payloadReady = Boolean(payload?.exists);

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <div className={cx(common.headRow)}>
        <h1 className={cx(common.title)}>{tr("statusTitle")}</h1>
        <Button
          variant="ghost"
          onClick={props.onRefresh}
          disabled={busy}
          testId={`${ROOT}--refresh`}
        >
          {tr("refresh")}
        </Button>
      </div>
      <p className={cx(common.lead)}>{tr("statusLead")}</p>

      {props.error ? <Note tone="error">{errorText(locale, props.error)}</Note> : null}
      {detecting ? <Note>{tr("statusSearching")}</Note> : null}

      {!detecting && game ? (
        <Panel testId={`${ROOT}--game`}>
          <div className={cx(common.headRow)}>
            <h2 className={cx(common.sectionTitle)}>{tr("gameFound")}</h2>
            <span className={cx(common.badge, installed ? common.badgeOk : common.badgeWarn)}>
              {installed ? tr("modInstalled") : tr("modNotInstalled")}
            </span>
          </div>
          <Row label={tr("gameFolder")} value={game.path} />
          <Row label={tr("steamBuild")} value={game.buildId ?? "—"} />

          {installed && status ? (
            <>
              <Row label={tr("rowVersion")} value={status.version ?? "—"} />
              <Row label={tr("rowLang")} value={status.lang ? status.lang.toUpperCase() : "—"} />
              <Row label={tr("rowFiles")} value={status.files} />
              <IntegrityNote locale={locale} status={status} />
            </>
          ) : (
            <>
              <p className={cx(common.muted)}>{tr("modNotInstalled")}</p>
              {status?.modDirExists ? <Note tone="warn">{tr("manifestPending")}</Note> : null}
            </>
          )}

          {payloadReady ? (
            <>
              <p className={cx(common.muted)}>
                {tr("payloadLine", {
                  version: payload?.version ?? "—",
                  count: payload?.langs.length ?? 0,
                })}
              </p>
              {hasUpdate ? (
                <Note tone="warn">
                  {tr("updateAvailable", {
                    from: status?.version ?? "—",
                    to: payload?.version ?? "—",
                  })}
                </Note>
              ) : null}
            </>
          ) : (
            <Note tone="warn">{tr("payloadMissing")}</Note>
          )}

          <div className={cx(common.headRow)}>
            <div />
            <div className={cx(common.field)}>
              {!installed ? (
                <Button
                  variant="primary"
                  onClick={props.onInstall}
                  disabled={!payloadReady || busy}
                  testId={`${ROOT}--install`}
                >
                  {tr("actionInstall")}
                </Button>
              ) : (
                <Button
                  variant={hasUpdate ? "primary" : "default"}
                  onClick={props.onUpdate}
                  disabled={!payloadReady || busy}
                  testId={`${ROOT}--update`}
                >
                  {tr("actionUpdate")}
                </Button>
              )}
              <Button
                onClick={props.onVerify}
                disabled={busy || !installed}
                testId={`${ROOT}--verify`}
              >
                {tr("actionVerify")}
              </Button>
              {installed ? (
                <Button
                  variant="danger"
                  onClick={props.onUninstall}
                  disabled={busy}
                  testId={`${ROOT}--uninstall`}
                >
                  {tr("actionUninstall")}
                </Button>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}

      {!detecting && !game ? (
        <Panel testId={`${ROOT}--not-found`}>
          <h2 className={cx(common.sectionTitle)}>{tr("gameNotFound")}</h2>
          <p className={cx(common.lead)}>{tr("gameNotFoundBody", { exe: EXE })}</p>
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
