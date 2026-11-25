import { LOCALE_LABELS, LOCALES, t } from "@/i18n";
import type { InstallerPlatform } from "@/core/types";
import { createPlatform } from "@/platform";
import { useInstaller } from "@/hooks/useInstaller";
import { Button, Note } from "@/ui/primitives";
import { cx } from "@/ui/cx";
import { Done } from "@/screens/Done";
import { Detect } from "@/screens/Detect";
import { Installing } from "@/screens/Installing";
import { Uninstall } from "@/screens/Uninstall";
import { Verify } from "@/screens/Verify";
import { Welcome } from "@/screens/Welcome";
import { styles } from "./App.styles";

const defaultPlatform = createPlatform();

export function App({ platform = defaultPlatform }: { platform?: InstallerPlatform }) {
  const controller = useInstaller(platform);
  const { state } = controller;
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
              onClick={() => controller.setLocale(locale)}
              testId={`App--locale-${locale}`}
            >
              {LOCALE_LABELS[locale]}
            </Button>
          ))}
        </div>
      </header>

      <main className={cx(styles.main)}>
        {platform.kind === "mock" ? <Note tone="warn">{tr("mockBanner")}</Note> : null}

        {state.screen === "welcome" ? (
          <Welcome
            locale={state.locale}
            payload={state.payload}
            ready={controller.ready}
            onStart={controller.start}
          />
        ) : null}

        {state.screen === "detect" ? (
          <Detect
            locale={state.locale}
            game={state.game}
            detecting={state.detecting}
            folderError={state.folderError}
            folderMissing={state.folderMissing}
            payload={state.payload}
            busy={state.busy}
            error={state.error}
            onChooseFolder={controller.chooseFolder}
            onInstall={controller.install}
            onUninstall={controller.uninstall}
            onVerify={controller.verify}
          />
        ) : null}

        {state.screen === "installing" ? (
          <Installing
            locale={state.locale}
            progress={state.progress}
            error={state.error}
            onRetry={controller.install}
            onBack={() => controller.navigate("detect")}
          />
        ) : null}

        {state.screen === "done" ? (
          <Done
            locale={state.locale}
            result={state.install}
            onVerify={controller.verify}
            onClose={() => controller.navigate("detect")}
          />
        ) : null}

        {state.screen === "uninstall" ? (
          <Uninstall
            locale={state.locale}
            game={state.game}
            busy={state.busy}
            result={state.uninstall}
            error={state.error}
            onConfirm={controller.uninstall}
            onCancel={() => controller.navigate("detect")}
            onBack={() => controller.navigate("detect")}
          />
        ) : null}

        {state.screen === "verify" ? (
          <Verify
            locale={state.locale}
            result={state.verify}
            busy={state.busy}
            error={state.error}
            onBack={() => controller.navigate("detect")}
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
