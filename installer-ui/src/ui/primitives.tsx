import type { ReactNode } from "react";

import { cx } from "./cx";
import { styles } from "./primitives.styles";

type ButtonVariant = "primary" | "default" | "danger" | "ghost";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  testId?: string;
}) {
  const { children, onClick, variant = "default", disabled = false, testId } = props;
  return (
    <button
      type="button"
      className={cx(
        styles.button,
        variant === "primary" && styles.primary,
        variant === "danger" && styles.danger,
        variant === "ghost" && styles.ghost,
      )}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

export function Panel(props: { children: ReactNode; testId?: string }) {
  return (
    <section className={cx(styles.panel)} data-testid={props.testId}>
      {props.children}
    </section>
  );
}

export function Note(props: { children: ReactNode; tone?: "info" | "ok" | "warn" | "error" }) {
  const { children, tone = "info" } = props;
  return (
    <div
      className={cx(
        styles.note,
        tone === "ok" && styles.noteOk,
        tone === "warn" && styles.noteWarn,
        tone === "error" && styles.noteError,
      )}
    >
      {children}
    </div>
  );
}

export function ProgressBar(props: { value: number }) {
  const width = `${Math.min(100, Math.max(0, props.value))}%`;
  return (
    <div className={cx(styles.progressTrack)}>
      <div className={cx(styles.progressFill)} style={{ width }} />
    </div>
  );
}

export function Row(props: { label: string; value: ReactNode }) {
  return (
    <div className={cx(styles.row)}>
      <span className={cx(styles.rowLabel)}>{props.label}</span>
      <span className={cx(styles.rowValue)}>{props.value}</span>
    </div>
  );
}
