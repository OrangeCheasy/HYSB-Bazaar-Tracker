import { useEffect, useId, useRef } from "react";
import { formatHour, formatPercent } from "../format.js";
import {
  utcOffsetHours,
  validate,
  wrapHour,
  type Settings,
  type SettingsErrors,
} from "../settings/schema.js";
import { resetSettings, updateSettings, useSettings } from "../settings/store.js";

/**
 * The settings drawer.
 *
 * These inputs change every number on the site, so they are a visible panel rather than
 * something buried (ROADMAP Phase 5). Changes apply immediately and persist to
 * localStorage — there is no Save button, because a scan that does not match the settings
 * on screen is worse than one that reloads a moment later.
 *
 * Validation messages come from `packages/core/src/params.ts`, the same table the Worker
 * rejects requests with, so this panel cannot save a value the API would answer with a
 * 400.
 */

interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: React.ReactNode;
}

function Field({ label, hint, error, children }: FieldProps): React.JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-dim">{label}</span>
      <div className="mt-1">{children}</div>
      {error !== undefined ? (
        <span className="mt-1 block text-xs text-outage">{error}</span>
      ) : hint !== undefined ? (
        <span className="mt-1 block text-xs text-ink-faint">{hint}</span>
      ) : null}
    </label>
  );
}

const inputClass =
  "num w-full rounded-sm border border-rule bg-surface px-2 py-1 text-sm text-ink " +
  "focus:border-accent focus:outline-none";

interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly hint?: string;
  readonly error?: string;
  readonly onChange: (value: number) => void;
}

function NumberField({
  label,
  value,
  step,
  hint,
  error,
  onChange,
}: NumberFieldProps): React.JSX.Element {
  return (
    <Field label={label} hint={hint} error={error}>
      <input
        type="number"
        className={inputClass}
        value={value}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          // An empty or half-typed input yields NaN; ignoring it leaves the last good
          // value in place rather than writing NaN into storage.
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </Field>
  );
}

function HourField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <Field label={label}>
      <select
        className={inputClass}
        value={value}
        onChange={(event) => onChange(wrapHour(Number(event.target.value)))}
      >
        {Array.from({ length: 24 }, (_, hour) => (
          <option key={hour} value={hour}>
            {formatHour(hour)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mt-6 mb-3 border-b border-rule pb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase first:mt-0">
      {children}
    </h3>
  );
}

function SettingsBody({
  settings,
  errors,
}: {
  readonly settings: Settings;
  readonly errors: SettingsErrors;
}): React.JSX.Element {
  const offset = utcOffsetHours();
  const offsetLabel = offset === 0 ? "UTC" : `UTC${offset > 0 ? "+" : ""}${offset}`;

  return (
    <div className="px-4 py-4 sm:px-5">
      <SectionHeading>Market</SectionHeading>
      <div className="grid gap-4">
        <NumberField
          label="Sell tax"
          value={settings.taxRate}
          step={0.0025}
          error={errors.taxRate}
          hint={`${formatPercent(settings.taxRate, 2)} — 1.25% base, 1% with Bazaar Flipper II, ~2.25% under Mayor Aura. Applies to sell offers only.`}
          onChange={(taxRate) => updateSettings({ taxRate })}
        />
        <NumberField
          label="Capture fraction"
          value={settings.captureFraction}
          step={0.05}
          error={errors.captureFraction}
          hint={`${formatPercent(settings.captureFraction, 0)} of observed volume assumed reachable by your orders.`}
          onChange={(captureFraction) => updateSettings({ captureFraction })}
        />
        <NumberField
          label="Undercut tick"
          value={settings.tick}
          step={1}
          error={errors.tick}
          hint="Price step used to sit in front of the queue, in coins."
          onChange={(tick) => updateSettings({ tick })}
        />
        <Field
          label="Capital available"
          error={errors.capital}
          hint={
            settings.capital === null
              ? "Unset — no capital constraint. Different from 0, which is a scan you cannot afford anything in."
              : "Rows needing more than this are marked as unaffordable rather than hidden."
          }
        >
          <div className="flex gap-2">
            <input
              type="number"
              className={inputClass}
              placeholder="no limit"
              value={settings.capital ?? ""}
              step={1_000_000}
              onChange={(event) => {
                const raw = event.target.value;
                const next = Number(raw);
                updateSettings({
                  capital: raw === "" ? null : Number.isFinite(next) ? next : settings.capital,
                });
              }}
            />
            {settings.capital !== null && (
              <button
                type="button"
                className="shrink-0 rounded-sm border border-rule px-2 text-xs text-ink-dim hover:text-ink"
                onClick={() => updateSettings({ capital: null })}
              >
                Clear
              </button>
            )}
          </div>
        </Field>
      </div>

      <SectionHeading>Weekly band</SectionHeading>
      <div className="grid gap-4">
        <NumberField
          label="Buy band percentile"
          value={settings.lowPercentile}
          step={0.05}
          error={errors.lowPercentile}
          hint={`p${Math.round(settings.lowPercentile * 100)} of hourly bid — where your buy order rests. A lower percentile fills less often.`}
          onChange={(lowPercentile) => updateSettings({ lowPercentile })}
        />
        <NumberField
          label="Sell band percentile"
          value={settings.highPercentile}
          step={0.05}
          error={errors.highPercentile}
          hint={`p${Math.round(settings.highPercentile * 100)} of hourly ask — where your sell offer rests.`}
          onChange={(highPercentile) => updateSettings({ highPercentile })}
        />
        <NumberField
          label="Trailing window (days)"
          value={settings.windowDays}
          step={1}
          error={errors.windowDays}
          hint="7 days is 168 hourly rows. Nothing older than 30 days exists — the whole dataset is a rolling month."
          onChange={(windowDays) => updateSettings({ windowDays })}
        />
      </div>

      <SectionHeading>Your hours</SectionHeading>
      <div className="grid gap-4">
        <p className="text-xs text-ink-faint">
          Shown in <span className="num">{settings.timeZone}</span> ({offsetLabel}) and sent to
          the API as UTC. These are the hours your buy orders sit unattended.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <HourField
            label="Sleep starts"
            value={settings.sleepStartLocal}
            onChange={(sleepStartLocal) => updateSettings({ sleepStartLocal })}
          />
          <HourField
            label="Sleep ends"
            value={settings.sleepEndLocal}
            onChange={(sleepEndLocal) => updateSettings({ sleepEndLocal })}
          />
        </div>
        <NumberField
          label="Sell window (hours)"
          value={settings.sellWindowHours}
          step={1}
          error={errors.sellWindowHours}
          hint="How long a sell offer rests. The model searches for the best window of this length; you choose the length, not the hour."
          onChange={(sellWindowHours) => updateSettings({ sellWindowHours })}
        />
      </div>

      <div className="mt-8 border-t border-rule pt-4">
        <button
          type="button"
          className="rounded-sm border border-rule px-2 py-1 text-xs text-ink-dim hover:border-rule-strong hover:text-ink"
          onClick={resetSettings}
        >
          Reset to defaults
        </button>
        <p className="mt-2 text-xs text-ink-faint">
          Stored in this browser only. There are no accounts.
        </p>
      </div>
    </div>
  );
}

export function SettingsDrawer({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  const settings = useSettings();
  const errors = validate(settings);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // Move focus into the panel so keyboard and screen-reader users land inside it rather
    // than continuing from the button behind the overlay.
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30">
      <button
        type="button"
        aria-label="Close settings"
        className="absolute inset-0 bg-ground/70"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Full width on a phone, a fixed column on a desktop: this is a form, and a form
        // stretched across a 2560px screen is unreadable.
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-rule bg-surface shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3 sm:px-5">
          <h2 id={titleId} className="text-sm font-semibold text-ink">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-rule px-2 py-1 text-xs text-ink-dim hover:text-ink"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SettingsBody settings={settings} errors={errors} />
        </div>
      </div>
    </div>
  );
}
