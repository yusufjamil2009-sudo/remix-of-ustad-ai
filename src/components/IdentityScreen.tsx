/**
 * WELCOME / ONE-TIME IDENTITY SETUP + the optional "secure this device" flow.
 *
 * `IdentityScreen` is shown ONLY when there is no usable authenticated identity
 * (first open, after LOG OUT, after CLEAR DATA, or an invalid/revoked session).
 * Once identity exists, USTAD AI opens straight to Home and this screen never
 * appears again until an explicit LOG OUT or CLEAR DATA.
 *
 * `SecureDeviceNotice` / `SecureDeviceDialog` are the NON-BLOCKING path for a
 * guest that already existed before this feature: its permanent Guest ID and
 * every piece of data are already valid, so it keeps going straight Home and is
 * merely offered a username + password. Nothing is ever taken away from it.
 *
 * There is no fake auth anywhere here: every button calls a server function
 * that verifies credentials server-side and returns a signed session, and no
 * Guest ID is ever created on the client.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UstadLogo } from "@/components/UstadLogo";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import {
  ERROR_TEXT,
  USERNAME_MAX,
  USERNAME_MIN,
  errorText,
  identityText,
  type IdentityErrorCode,
} from "@/lib/identity-spec";
import { useIdentityLanguage } from "@/lib/identity-language";
import {
  claimCurrentIdentity,
  createIdentity,
  restoreIdentity,
  retryIdentity,
  useGuest,
} from "@/lib/ustad-client";
import { toast } from "sonner";

type Mode = "choose" | "new" | "backup";

/** Shared credential form for creating a Guest ID, restoring one, or claiming the current guest. */
function CredentialForm({
  mode,
  onSubmit,
  busyLabel,
  submitLabel,
  onCancel,
}: {
  mode: "new" | "backup";
  onSubmit: (username: string, password: string) => Promise<void>;
  busyLabel: string;
  submitLabel: string;
  onCancel: () => void;
}) {
  const language = useIdentityLanguage();
  const t = identityText(language);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        if (mode === "new" && password !== confirm) {
          setError(t.passwordMismatch);
          return;
        }
        setBusy(true);
        setError(null);
        await onSubmit(username, password);
        setBusy(false);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`ustad-username-${mode}`}>{t.username}</Label>
        <Input
          id={`ustad-username-${mode}`}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          minLength={USERNAME_MIN}
          maxLength={USERNAME_MAX}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t.usernamePlaceholder}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`ustad-password-${mode}`}>{t.password}</Label>
        <Input
          id={`ustad-password-${mode}`}
          name="password"
          type="password"
          autoComplete={mode === "new" ? "new-password" : "current-password"}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t.passwordPlaceholder}
        />
      </div>
      {mode === "new" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ustad-confirm-password">{t.confirmPassword}</Label>
          <Input
            id="ustad-confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
        {t.back}
      </Button>
    </form>
  );
}

export function IdentityScreen() {
  const language = useIdentityLanguage();
  const t = identityText(language);
  const { status, transient } = useGuest();
  const [mode, setMode] = useState<Mode>("choose");
  const [error, setError] = useState<string | null>(null);

  const networkError = transient || status === "error";

  async function run(action: () => Promise<{ ok: boolean; code?: IdentityErrorCode }>) {
    setError(null);
    const res = await action();
    if (!res.ok) setError(errorText((res.code ?? "validation") as IdentityErrorCode, language));
  }

  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-card ring-1 ring-border">
            <UstadLogo className="size-10" priority />
          </span>
          <h1 className="font-display text-2xl font-semibold gold-text">{t.welcomeTitle}</h1>
          <p className="text-sm text-muted-foreground">{t.welcomeSubtitle}</p>
          <ThemeSwitch />
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          {networkError ? (
            <div className="flex flex-col gap-3">
              <p role="alert" className="text-sm text-destructive">
                {ERROR_TEXT[language]["network"]}
              </p>
              <p className="text-xs text-muted-foreground">{ERROR_TEXT[language]["session"]}</p>
              <Button onClick={() => void retryIdentity()}>{t.back}</Button>
            </div>
          ) : mode === "choose" ? (
            <div className="flex flex-col gap-3">
              <Button size="lg" onClick={() => setMode("new")}>
                {t.newGuest}
              </Button>
              <p className="text-center text-xs text-muted-foreground">{t.noAccount}</p>
              <div className="my-1 flex items-center gap-2 text-[10px] tracking-widest text-muted-foreground uppercase">
                <span className="h-px flex-1 bg-border" />
                {t.haveAccount}
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button variant="outline" size="lg" onClick={() => setMode("backup")}>
                {t.backupId}
              </Button>
              <p className="text-center text-xs text-muted-foreground">{t.restoreBackupHint}</p>
            </div>
          ) : mode === "new" ? (
            <CredentialForm
              mode="new"
              busyLabel={t.creating}
              submitLabel={t.createGuestId}
              onCancel={() => setMode("choose")}
              onSubmit={async (username, password) => {
                await run(() => createIdentity(username, password));
              }}
            />
          ) : (
            <CredentialForm
              mode="backup"
              busyLabel={t.restoring}
              submitLabel={t.restoreBackup}
              onCancel={() => setMode("choose")}
              onSubmit={async (username, password) => {
                await run(() => restoreIdentity(username, password));
              }}
            />
          )}

          {!networkError && error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Optional one-time setup for a guest that already exists             */
/* ------------------------------------------------------------------ */

/**
 * Dismissal is stored PER GUEST, so dismissing the offer on one account never
 * hides it for a different account that signs in on the same device (§15).
 * It is an identity-scoped key, so Clear Data removes it and the offer returns.
 */
function dismissKey(guestId: string): string {
  return `ustad.identity.setupDismissed.${guestId}`;
}

export function SecureDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const language = useIdentityLanguage();
  const t = identityText(language);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t.secureDevice}</DialogTitle>
          <DialogDescription>{t.secureDeviceHint}</DialogDescription>
        </DialogHeader>
        <CredentialForm
          mode="new"
          busyLabel={t.creating}
          submitLabel={t.secureDevice}
          onCancel={() => onOpenChange(false)}
          onSubmit={async (username, password) => {
            const res = await claimCurrentIdentity(username, password);
            if (res.ok) {
              toast.success(t.secureDevice);
              onOpenChange(false);
              return;
            }
            setError(errorText(res.code, language));
          }}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Non-blocking banner: this device already has a valid permanent Guest ID, so
 * the user keeps full access to their data while being offered credentials.
 * Dismissing it never affects the identity.
 */
/** Reads the per-guest dismissal flag (identity-scoped; cleared by Clear Data). */
function useDismissedOffer(guestId: string): boolean {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!guestId) {
      setDismissed(false);
      return;
    }
    const read = () => {
      try {
        setDismissed(window.localStorage.getItem(dismissKey(guestId)) === "1");
      } catch {
        setDismissed(false);
      }
    };
    read();
    window.addEventListener("ustad:identity-offer-dismissed", read);
    return () => window.removeEventListener("ustad:identity-offer-dismissed", read);
  }, [guestId]);
  return dismissed;
}

function dismissOffer(guestId: string): void {
  try {
    window.localStorage.setItem(dismissKey(guestId), "1");
  } catch {
    /* dismissal is best effort */
  }
  // Re-render the banner away without touching the identity.
  window.dispatchEvent(new Event("ustad:identity-offer-dismissed"));
}

export function SecureDeviceNotice() {
  const language = useIdentityLanguage();
  const t = identityText(language);
  const { guestId, hasAccount } = useGuest();
  const [open, setOpen] = useState(false);
  const dismissed = useDismissedOffer(guestId);

  // The moment the SERVER says this guest has credentials, the offer is gone —
  // local state can never keep showing or hide a stale identity prompt (§16).
  if (dismissed || !guestId || hasAccount) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/60 px-4 py-2 text-xs md:px-8">
      <p className="text-muted-foreground">{t.secureDeviceHint}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t.secureDevice}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => dismissOffer(guestId)}>
          {t.cancel}
        </Button>
      </div>
      <SecureDeviceDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
