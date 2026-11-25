import { LOCALE_LABELS, LOCALES, t } from "@/i18n";
import type { InstallerPlatform } from "@/core/types";
import { createPlatform } from "@/platform";
import { useManager } from "@/hooks/useManager";
import { Button, Note } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { Done } from "@/screens/Done";
import { Progress } from "@/screens/Progress";
import { Status } from "@/screens/Status";
import { Uninstall } from "@/screens/Uninstall";
import { Verify } from "@/screens/Verify";
import { styles } from "./App.styles";

const defaultPlatform = createPlatform();

export function App({ platform = defaultPlatform }: { platform?: InstallerPlatform }) {
  const manager = useManager(platform);
  const { state } = manager;
  const tr = (key: Parameters<typeof t>[1]) => t(state.locale, key);

  return (
    <div className={cx(styles.app)}>
      <header className={cx(styles.header)}>
        <div className={cx(styles.brand)}>
          <span className={cx(styles.brandTitle)}>{tr("appTitle")}</span>
          <span className={cx(styles.brandSub)}>
            {tr("appSubtitle")} · {tr("winNote")}
          </span>
        </div>
        <div className={cx(styles.headerRight)}>
          <span className={cx(styles.langLabel)}>{tr("langLabel")}</span>
          {LOCALES.map((locale) => (
            <Button
              key={locale}
              variant={locale === state.locale ? "primary" : "ghost"}
              onClick={() => manager.setLocale(locale)}
              testId={`App--locale-${locale}`}
            >
              {LOCALE_LABELS[locale]}
            </Button>
          ))}
        </div>
      </header>

      <main className={cx(styles.main)}>
        {platform.kind === "mock" ? <Note tone="warn">{tr("mockBanner")}</Note> : null}

        {state.screen === "status" ? (
          <Status
            locale={state.locale}
            game={state.game}
            status={state.status}
            payload={state.payload}
            detecting={state.detecting}
            folderError={state.folderError}
            folderMissing={state.folderMissing}
            busy={state.busy}
            error={state.error}
            onRefresh={manager.refresh}
            onChooseFolder={manager.chooseFolder}
            onInstall={manager.install}
            onUpdate={manager.update}
            onVerify={manager.verify}
            onUninstall={manager.uninstall}
          />
        ) : null}

        {state.screen === "progress" ? (
          <Progress
            locale={state.locale}
            op={state.op}
            progress={state.progress}
            error={state.error}
            onRetry={manager.retry}
            onBack={() => manager.navigate("status")}
          />
        ) : null}

        {state.screen === "done" ? (
          <Done
            locale={state.locale}
            op={state.op}
            result={state.result}
            onVerify={manager.verify}
            onBack={() => manager.navigate("status")}
          />
        ) : null}

        {state.screen === "uninstall" ? (
          <Uninstall
            locale={state.locale}
            game={state.game}
            busy={state.busy}
            result={state.uninstall}
            error={state.error}
            onConfirm={manager.uninstall}
            onCancel={() => manager.navigate("status")}
            onBack={() => manager.navigate("status")}
          />
        ) : null}

        {state.screen === "verify" ? (
          <Verify
            locale={state.locale}
            result={state.verify}
            busy={state.busy}
            error={state.error}
            onBack={() => manager.navigate("status")}
          />
        ) : null}
      </main>

      <footer className={cx(styles.footer)}>
        <span>{tr("appTitle")} · v0.1.0</span>
        <span>{tr("winNote")}</span>
      </footer>
    </div>
  );
}
