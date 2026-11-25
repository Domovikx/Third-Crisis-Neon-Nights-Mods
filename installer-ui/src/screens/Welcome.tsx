import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import type { PayloadStatus } from "@/core/types";
import { Button, Note, Panel } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { common } from "./common.styles";

export const ROOT = "Welcome";

export function Welcome(props: {
  locale: Locale;
  payload: PayloadStatus | null;
  ready: boolean;
  onStart: () => void;
}) {
  const { locale, payload, ready } = props;
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(locale, key, vars);

  return (
    <div className={cx(common.stack)} data-testid={ROOT}>
      <h1 className={cx(common.title)}>{tr("welcomeTitle")}</h1>
      <p className={cx(common.lead)}>{tr("welcomeLead")}</p>

      <Panel testId={`${ROOT}--included`}>
        <h2 className={cx(common.sectionTitle)}>{tr("welcomeIncluded")}</h2>
        <ul className={cx(common.list)}>
          <li>
            <code>dwmapi.dll</code> — {tr("welcomeLoader")}
          </li>
          <li>
            <code>mods/NeonTranslatorDX/</code> — {tr("welcomeModFolder")}
          </li>
        </ul>
        <p className={cx(common.muted)}>{tr("welcomeSafe")}</p>
      </Panel>

      {payload && !payload.exists ? <Note tone="warn">{tr("payloadMissing")}</Note> : null}
      {payload?.exists ? (
        <p className={cx(common.muted)}>
          {tr("payloadLine", { version: payload.version ?? "—", count: payload.langs.length })}
        </p>
      ) : null}

      <div>
        <Button
          variant="primary"
          onClick={props.onStart}
          disabled={!ready}
          testId={`${ROOT}--start`}
        >
          {tr("start")}
        </Button>
      </div>
    </div>
  );
}
