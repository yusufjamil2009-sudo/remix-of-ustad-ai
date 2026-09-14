import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, KeyRound, User, Sliders, ShieldAlert, Trash2, Plug, Images } from "lucide-react";
import { toast } from "sonner";
import { AppShell, PageHeader } from "@/components/AppShell";
import { GallerySection } from "@/components/GallerySection";
import { PwaInstallCard } from "@/components/PwaInstallCard";
import { ThemeSwitch } from "@/components/ThemeSwitch";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PROVIDERS, CATEGORIES, STATUS_LABELS } from "@/lib/providers";
import {
  useGuest,
  shortId,
  clearLocalCache,
  clearLocalData,
  logoutIdentity,
  readStoredUsername,
} from "@/lib/ustad-client";
import { useSettings, saveProfilePatch } from "@/lib/settings-store";
import { useIdentityLanguage } from "@/lib/identity-language";
import { errorText, identityText } from "@/lib/identity-spec";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { crorepatiProfileStatsFn, crorepatiEntryProfileStatsFn } from "@/lib/crorepati.functions";
import { walletPanelFn } from "@/lib/wallet.functions";
import {
  avatarStateFn,
  avatarUploadFn,
  avatarRemoveFn,
  avatarEquipFrameFn,
  avatarRemoveFrameFn,
} from "@/lib/avatar.functions";
import { megaProfileStatsFn } from "@/lib/mega.functions";
import { AchievementShowcase } from "@/components/AchievementShowcase";
import { CertificateSection } from "@/components/CertificateSection";
import { ProfileLeaderboard } from "@/components/ProfileLeaderboard";
import { ProfileIdentity } from "@/components/ProfileIdentity";
import {
  listApiConfigsFn,
  saveApiConfigFn,
  testApiConfigFn,
  deleteApiConfigFn,
  setApiModelFn,
  saveProfileFn,
  saveSettingsFn,
  clearCacheFn,
  clearDataFn,
} from "@/lib/ustad-api";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings & API Manager | USTAD AI" },
      {
        name: "description",
        content:
          "Connect 27+ AI, search, voice and database providers, tune your profile, and control your guest data.",
      },
      { property: "og:title", content: "Settings & API Manager — USTAD AI" },
      {
        property: "og:description",
        content: "Bring your own keys, personalise USTAD, and manage your private data.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettingsPage,
});

type ConfigState = {
  provider: string;
  status: string;
  statusDetail: string | null;
  models: string[];
  freeModels?: string[];
  selectedModel?: string;
  defaultModel?: string;
  latencyMs: number | null;
  filled: Record<string, unknown>;
};

function SettingsPage() {
  const { token, session, ready, status, error, retry } = useGuest();
  return (
    <AppShell>
      <PageHeader
        title="Settings"
        subtitle="Your keys, your profile, your data — all stored under your guest ID."
      />
      <div className="hide-scrollbar flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {!ready ? (
          <div className="panel mx-auto mb-4 flex max-w-4xl items-center gap-2 p-4 text-sm text-muted-foreground">
            {status === "error" ? (
              <>
                <span>Your guest workspace could not be reached.</span>
                <Button size="sm" variant="secondary" onClick={retry}>
                  Retry
                </Button>
                {error ? <span className="text-xs">{error}</span> : null}
              </>
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" /> Restoring your guest workspace…
              </>
            )}
          </div>
        ) : null}
        <Tabs defaultValue="apis" className="mx-auto max-w-4xl">
          <TabsList>
            <TabsTrigger value="apis">
              <KeyRound className="mr-1 size-4" /> API Manager
            </TabsTrigger>
            <TabsTrigger value="profile">
              <User className="mr-1 size-4" /> Profile
            </TabsTrigger>
            <TabsTrigger value="prefs">
              <Sliders className="mr-1 size-4" /> Preferences
            </TabsTrigger>
            <TabsTrigger value="data">
              <ShieldAlert className="mr-1 size-4" /> Data
            </TabsTrigger>
            <TabsTrigger value="gallery">
              <Images className="mr-1 size-4" /> USTAD Gallery
            </TabsTrigger>
          </TabsList>

          <TabsContent value="apis" className="mt-4">
            {ready ? <ApiManager token={token} /> : null}
          </TabsContent>
          <TabsContent value="profile" className="mt-4">
            <ProfilePanel initial={(session?.profile ?? null) as Record<string, unknown> | null} />
          </TabsContent>
          <TabsContent value="prefs" className="mt-4 space-y-4">
            <PrefsPanel />
            <PwaInstallCard />
          </TabsContent>
          <TabsContent value="data" className="mt-4">
            <div className="panel space-y-4 p-5">
              <IdentityDataActions token={token} guestId={session?.guestId ?? ""} />
            </div>
          </TabsContent>
          <TabsContent value="gallery" className="mt-4">
            {ready ? <GallerySection /> : null}
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

function ApiManager({ token }: { token: string }) {
  const [configs, setConfigs] = useState<ConfigState[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("All");

  const refresh = async () => {
    if (!token) return;
    setConfigs((await listApiConfigsFn({ data: { token } })) as unknown as ConfigState[]);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const list = PROVIDERS.filter(
    (p) => category === "All" || p.categories.includes(category as never),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {["All", ...CATEGORIES].map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              category === c
                ? "bg-primary text-primary-foreground"
                : "bg-surface-2 text-muted-foreground"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((def) => {
          const state = configs.find((c) => c.provider === def.id);
          const status = state?.status ?? "not_configured";
          const tone =
            status === "connected"
              ? "text-success"
              : status === "failed"
                ? "text-destructive"
                : status === "not_configured"
                  ? "text-muted-foreground"
                  : "text-warning";
          return (
            <div key={def.id} className="panel space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{def.name}</p>
                  <p className="text-xs text-muted-foreground">{def.categories.join(" · ")}</p>
                </div>
                <span className={`text-xs ${tone}`}>{STATUS_LABELS[status] ?? status}</span>
              </div>
              {state?.statusDetail ? (
                <p className="text-xs text-muted-foreground">{state.statusDetail}</p>
              ) : null}
              {state?.models?.length ? (
                <p className="text-[11px] text-muted-foreground">
                  {state.models.slice(0, 3).join(", ")}
                </p>
              ) : null}

              {status !== "not_configured" && def.chat ? (
                <div className="space-y-1">
                  <Label className="text-xs">Model (free tier only)</Label>
                  <select
                    className="h-9 w-full rounded-md border border-border bg-surface-2 px-2 text-xs"
                    value={state?.selectedModel ?? ""}
                    disabled={busy === def.id}
                    onChange={async (e) => {
                      const model = e.target.value;
                      setBusy(def.id);
                      try {
                        await setApiModelFn({ data: { token, provider: def.id, model } });
                        toast.success(
                          model
                            ? `Model set to ${model}`
                            : "Using Default — best active free model",
                        );
                        await refresh();
                      } catch (err) {
                        toast.error((err as Error).message);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    <option value="">
                      {state?.defaultModel
                        ? `Default — best free model (${state.defaultModel})`
                        : "Default — best free model"}
                    </option>
                    {(state?.freeModels ?? []).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  {!(state?.freeModels ?? []).length ? (
                    <p className="text-[11px] text-muted-foreground">
                      No free-tier model detected yet — run Test to refresh the list.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {open === def.id ? (
                <div className="space-y-2 pt-2">
                  {def.fields.map((f) => (
                    <div key={f.key} className="space-y-1">
                      <Label className="text-xs">
                        {f.label}
                        {f.required ? " *" : ""}
                      </Label>
                      <Input
                        type={f.secret ? "password" : "text"}
                        value={draft[f.key] ?? ""}
                        placeholder={(state?.filled?.[f.key] as string) || f.placeholder || ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      disabled={busy === def.id}
                      onClick={async () => {
                        setBusy(def.id);
                        try {
                          await saveApiConfigFn({
                            data: { token, provider: def.id, config: draft },
                          });
                          const res = await testApiConfigFn({ data: { token, provider: def.id } });
                          toast[res.status === "connected" ? "success" : "error"](res.detail);
                          setDraft({});
                          setOpen(null);
                          await refresh();
                        } catch (e) {
                          toast.error((e as Error).message);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === def.id ? (
                        <Loader2 className="mr-1 size-3.5 animate-spin" />
                      ) : (
                        <Plug className="mr-1 size-3.5" />
                      )}
                      Save & test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                      Cancel
                    </Button>
                    {status !== "not_configured" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await deleteApiConfigFn({ data: { token, provider: def.id } });
                          await refresh();
                        }}
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setOpen(def.id);
                      setDraft({});
                    }}
                  >
                    {status === "not_configured" ? "Connect" : "Edit"}
                  </Button>
                  {status !== "not_configured" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === def.id}
                      onClick={async () => {
                        setBusy(def.id);
                        const res = await testApiConfigFn({ data: { token, provider: def.id } });
                        toast[res.status === "connected" ? "success" : "error"](res.detail);
                        setBusy(null);
                        await refresh();
                      }}
                    >
                      Test
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProfilePanel({ initial }: { initial: Record<string, unknown> | null }) {
  const [form, setForm] = useState<{
    name: string;
    age: string;
    education: string;
    interests: string;
    language: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // persisted value → state (never default → overwrite persisted)
  useEffect(() => {
    if (!initial || form) return;
    setForm({
      name: String(initial["name"] ?? ""),
      age: initial["age"] == null ? "" : String(initial["age"]),
      education: String(initial["education"] ?? ""),
      interests: String(initial["interests"] ?? ""),
      language: String(initial["language"] ?? "english"),
    });
  }, [initial, form]);

  return (
    <>
      <ProfileAvatarPanel />
      <ProfileIdentity />
      <div className="panel mb-4 space-y-2 p-5">
        <Label>Appearance</Label>
        <p className="text-xs text-muted-foreground">
          Choose light, dark or follow your system. Saved on this device.
        </p>
        <ThemeSwitch showLabels />
      </div>
      <div className="panel space-y-3 p-5">
        {!form ? (
          <p className="text-sm text-muted-foreground">Loading your profile…</p>
        ) : (
          <>
            {[
              ["name", "Your name"],
              ["age", "Age"],
              ["education", "Class / Education"],
              ["interests", "Interests"],
            ].map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label>{label}</Label>
                <Input
                  value={form[k as keyof typeof form]}
                  onChange={(e) => setForm((f) => (f ? { ...f, [String(k)]: e.target.value } : f))}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label>Preferred language</Label>
              <select
                value={form.language}
                onChange={(e) => setForm((f) => (f ? { ...f, language: e.target.value } : f))}
                className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {["english", "hindi", "hinglish"].map((l) => (
                  <option key={l} value={l} className="bg-surface">
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <Button
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await saveProfilePatch({ ...form, age: form.age ? Number(form.age) : null });
                  toast.success("Profile saved");
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save profile
            </Button>
          </>
        )}
      </div>
      <UstadCoinWallet />
      <CrorepatiProfileStats />
      <CrorepatiEntryStats />
      <MegaProfileStats />
      <AchievementShowcase />
      <CertificateSection />
      <ProfileLeaderboard />
    </>
  );
}

/**
 * Profile DP / avatar + equipped avatar frame (Part 8), rendered INSIDE the
 * existing profile. Clicking the picture opens the device's native gallery /
 * photo picker; the chosen image is validated and stored server-side, so it
 * survives refresh, reopening the app and new sessions.
 */
function ProfileAvatarPanel() {
  const { token } = useGuest();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<Awaited<ReturnType<typeof avatarStateFn>> | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setState((await avatarStateFn({ data: { token } })) as never);
    } catch {
      setState(null);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One image, straight from the native picker → validate → upload → show. */
  const onPick = useCallback(
    async (file: File | undefined) => {
      if (!file || !token) return;
      setBusy(true);
      // Lightweight local preview so the user sees their choice immediately.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result ?? ""));
        fr.onerror = () => reject(new Error("read failed"));
        fr.readAsDataURL(file);
      }).catch(() => "");

      if (!dataUrl) {
        toast.error("Ye image upload nahi ho sakti. Kripya valid image select karein.");
        setBusy(false);
        return;
      }
      setPreview(dataUrl);

      try {
        const next = await avatarUploadFn({ data: { token, dataUrl, fileName: file.name } });
        setState(next as never);
        toast.success("Profile picture updated.");
      } catch (err) {
        // The old DP is still in place server-side — drop only the preview.
        setPreview(null);
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [token],
  );

  const act = useCallback(async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      setState((await fn()) as never);
      setPreview(null);
      toast.success(okMsg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }, []);

  const shown = preview ?? state?.avatarUrl ?? null;
  const frame = state?.frames.find((f) => f.equipped) ?? null;
  const ownedFrames = state?.frames.filter((f) => f.owned) ?? [];

  return (
    <div className="panel mb-4 space-y-4 p-5" data-testid="profile-avatar-panel">
      <Label>Profile picture</Label>

      <div className="flex flex-wrap items-center gap-4">
        {/* The DP itself is the button — clicking it opens the native picker. */}
        <button
          type="button"
          data-testid="avatar-click"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Change your profile picture"
          className="relative size-24 shrink-0 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span
            data-testid="avatar-frame-ring"
            data-frame={frame?.itemId ?? ""}
            className={`absolute inset-0 rounded-full ${
              frame ? "ring-4 ring-amber-400" : "ring-1 ring-border"
            }`}
            aria-hidden
          />
          {shown ? (
            // object-cover fills the circle without stretching or distorting.
            <img
              src={shown}
              alt="Your profile picture"
              data-testid="avatar-image"
              className="size-24 rounded-full object-cover"
            />
          ) : (
            <span
              data-testid="avatar-default"
              className="flex size-24 items-center justify-center rounded-full bg-muted text-2xl font-semibold text-muted-foreground"
            >
              U
            </span>
          )}
          {busy ? (
            <span className="absolute inset-0 grid place-items-center rounded-full bg-background/60">
              <Loader2 className="size-5 animate-spin" aria-hidden />
            </span>
          ) : null}
        </button>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Tap your picture to choose one from your gallery.
            <br />
            JPG, PNG, WebP, GIF, HEIC or AVIF up to 5 MB.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Change picture
            </Button>
            {state?.hasCustomAvatar ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="avatar-remove"
                disabled={busy}
                onClick={() =>
                  act(() => avatarRemoveFn({ data: { token: token! } }), "Profile picture removed.")
                }
              >
                Remove DP
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* The native gallery / photo picker. capture is deliberately absent so
          mobile browsers offer the photo library, not just the camera. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,image/avif,image/bmp"
        className="hidden"
        data-testid="avatar-input"
        onChange={(e) => void onPick(e.target.files?.[0])}
      />

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Avatar frames {frame ? `· equipped: ${frame.name}` : "· none equipped"}
        </p>
        {ownedFrames.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You do not own any avatar frames yet. Buy one in the USTAD Shop.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="owned-frames">
            {ownedFrames.map((f) =>
              f.equipped ? (
                <Button
                  key={f.itemId}
                  size="sm"
                  variant="secondary"
                  disabled
                  data-testid={`frame-equipped-${f.itemId}`}
                >
                  {f.name} · Equipped ✓
                </Button>
              ) : (
                <Button
                  key={f.itemId}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid={`frame-equip-${f.itemId}`}
                  onClick={() =>
                    act(
                      () => avatarEquipFrameFn({ data: { token: token!, itemId: f.itemId } }),
                      `${f.name} equipped.`,
                    )
                  }
                >
                  Equip {f.name}
                </Button>
              ),
            )}
            {frame ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="frame-remove"
                disabled={busy}
                onClick={() =>
                  act(() => avatarRemoveFrameFn({ data: { token: token! } }), "Frame removed.")
                }
              >
                Remove Frame
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * USTAD Coin wallet + coin history, rendered INSIDE the existing profile
 * (Part 7). The balance shown here is the authoritative database value read
 * from the server on every mount — never a locally computed number.
 */
function UstadCoinWallet() {
  const { token } = useGuest();
  const [panel, setPanel] = useState<Awaited<ReturnType<typeof walletPanelFn>> | null>(null);

  useEffect(() => {
    if (!token) return;
    void walletPanelFn({ data: { token } })
      .then((r) => setPanel(r as never))
      .catch(() => setPanel(null));
  }, [token]);

  if (!panel) return null;

  return (
    <div className="panel mt-4 space-y-3 p-5" data-testid="profile-wallet">
      <Label>USTAD Coins</Label>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Balance</dt>
          <dd className="font-semibold" data-testid="profile-balance">
            {panel.wallet.balance.toLocaleString("en-IN")}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Lifetime earned</dt>
          <dd className="font-semibold">{panel.wallet.lifetimeEarned.toLocaleString("en-IN")}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Lifetime spent</dt>
          <dd className="font-semibold">{panel.wallet.lifetimeSpent.toLocaleString("en-IN")}</dd>
        </div>
      </dl>

      {panel.history.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">USTAD Coin History</p>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm" data-testid="coin-history">
            {panel.history.map((tx) => (
              <li
                key={tx.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate">{tx.note}</span>
                  <span className="block text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleDateString("en-IN")}
                    {tx.balanceAfter !== null
                      ? ` · balance ${tx.balanceAfter.toLocaleString("en-IN")}`
                      : ""}
                  </span>
                </span>
                <span
                  className={`shrink-0 font-semibold ${
                    tx.direction === "SPEND" ? "text-red-400" : "text-emerald-400"
                  }`}
                >
                  {tx.amount > 0 ? "+" : ""}
                  {tx.amount.toLocaleString("en-IN")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Crorepati summary rendered INSIDE the existing USTAD profile.
 * Part 1 deliberately does not create a second profile page.
 */
function CrorepatiProfileStats() {
  const { token } = useGuest();
  const [stats, setStats] = useState<{
    attempts: number;
    wins: number;
    losses: number;
    totalQuestionsCleared: number;
    totalCoins: number;
    bestCleared: number;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    void crorepatiProfileStatsFn({ data: { token } })
      .then((r) => setStats(r as never))
      .catch(() => setStats(null));
  }, [token]);

  if (!stats || !stats.attempts) return null;
  const rows: Array<[string, string | number]> = [
    ["Attempts", stats.attempts],
    ["Wins", stats.wins],
    ["Losses", stats.losses],
    ["Questions cleared", stats.totalQuestionsCleared],
    ["Best performance", `${stats.bestCleared} / 20`],
    ["USTAD Coins from Crorepati", stats.totalCoins.toLocaleString("en-IN")],
  ];
  return (
    <div className="panel mt-4 space-y-2 p-5">
      <Label>Kon Banega Crorepati</Label>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PrefsPanel() {
  const { settings, ready, update } = useSettings();

  const change = async (patch: Record<string, unknown>) => {
    try {
      await update(patch as never);
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!ready || !settings) {
    return <div className="panel p-5 text-sm text-muted-foreground">Loading your preferences…</div>;
  }
  const prefs = settings;

  return (
    <div className="panel space-y-4 p-5">
      <div className="space-y-1">
        <Label>Reply language</Label>
        <select
          value={prefs.language}
          onChange={(e) => void change({ language: e.target.value })}
          className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {["english", "hindi", "hinglish"].map((l) => (
            <option key={l} value={l} className="bg-surface">
              {l}
            </option>
          ))}
        </select>
        {prefs.timezone ? (
          <p className="text-xs text-muted-foreground">Time zone: {prefs.timezone}</p>
        ) : null}
      </div>
      {[
        ["data_saver", "Data saver (shorter replies)"],
        ["auto_speak", "Auto read answers aloud"],
        ["web_search", "Allow live web search"],
      ].map(([k, label]) => (
        <div key={k} className="flex items-center justify-between">
          <Label>{label}</Label>
          <Switch
            checked={Boolean(prefs[k as keyof typeof prefs])}
            onCheckedChange={(v) => void change({ [String(k)]: v })}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Settings → Data.
 *
 * This is the ONE place for the three identity/data actions, all localized
 * through the existing Settings language (never a second language system):
 *
 *   LOG OUT      — revokes the session server-side. The permanent Guest ID,
 *                  username, password hash and every piece of data stay on the
 *                  server. Next open → Welcome. Logout is NOT account deletion.
 *   CLEAR CACHE  — temporary client files only. Identity and permanent data are
 *                  guarded out of the action, so the next open goes Home.
 *   CLEAR DATA   — destructive LOCAL action, gated behind a confirmation
 *                  dialog. Clears this device's local data only; the server
 *                  account survives and can be reconnected with Backup ID.
 *                  Clear Data is NOT account deletion.
 *
 * The pre-existing server-side scope deletion ("Delete selected") is kept
 * exactly as it was, deliberately separate from the local Clear Data action.
 */
function IdentityDataActions({ token, guestId }: { token: string; guestId: string }) {
  const language = useIdentityLanguage();
  const t = identityText(language);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<"logout" | "cache" | "data" | null>(null);
  const [username, setUsername] = useState("");
  const { username: sessionUsername } = useGuest();

  useEffect(() => {
    // Prefer the SERVER account username; the local copy is only a cache and is
    // never treated as the identity (§16).
    setUsername(sessionUsername || readStoredUsername());
  }, [guestId, sessionUsername]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface-2/40 px-3 py-2">
        <p className="text-xs tracking-widest text-muted-foreground uppercase">{t.accountLabel}</p>
        <p className="font-mono text-sm">{username || "—"}</p>
        <p className="mt-1 text-xs tracking-widest text-muted-foreground uppercase">
          {t.guestIdLabel}
        </p>
        <p className="font-mono text-sm">{guestId ? shortId(guestId) : "…"}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={async () => {
            setBusy("logout");
            const res = await logoutIdentity();
            setBusy(null);
            if (res.ok) {
              toast.success(t.loggedOut);
              return;
            }
            // The server could not confirm the revocation, so the session was
            // kept. Say so instead of pretending the user signed out (§4).
            toast.error(errorText(res.code, language));
          }}
        >
          {t.logOut}
        </Button>
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => {
            setBusy("cache");
            // Cache scope is the allowlist in identity-spec: identity, session
            // and permanent data are guarded out, so the user stays signed in.
            clearLocalCache();
            setBusy(null);
            toast.success(t.cacheCleared);
          }}
        >
          {t.clearCache}
        </Button>
        <Button variant="destructive" disabled={busy !== null} onClick={() => setConfirmOpen(true)}>
          {t.clearData}
        </Button>
      </div>

      <dl className="space-y-1 text-xs text-muted-foreground">
        <div className="flex gap-2">
          <dt className="font-semibold text-foreground">{t.logOut}:</dt>
          <dd>{t.logOutHint}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold text-foreground">{t.clearCache}:</dt>
          <dd>{t.clearCacheHint}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold text-foreground">{t.clearData}:</dt>
          <dd>{t.clearDataHint}</dd>
        </div>
      </dl>

      <ConfirmDialog
        open={confirmOpen}
        busy={busy === "data"}
        title={t.clearDataConfirmTitle}
        body={t.clearDataConfirmBody}
        confirmLabel={t.confirm}
        cancelLabel={t.cancel}
        onCancel={() => {
          // Cancel does nothing at all: no local data is cleared and the
          // session stays exactly as it was.
          setConfirmOpen(false);
        }}
        onConfirm={() => {
          setBusy("data");
          clearLocalData();
          setBusy(null);
          setConfirmOpen(false);
          toast.success(t.dataCleared);
        }}
      />

      {/* The legacy server-side per-scope deletion, unchanged. */}
      <div className="border-t border-border pt-4">
        <LegacyScopePanel token={token} />
      </div>
    </div>
  );
}

function LegacyScopePanel({ token }: { token: string }) {
  const scopes = [
    "conversations",
    "notes",
    "memories",
    "goals",
    "reminders",
    "lessons",
    "exams",
    "attachments",
  ];
  const [selected, setSelected] = useState<string[]>([]);

  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Server data scopes
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Permanently delete selected server-side data for this Guest ID only. This is a separate
          destructive action from Clear Data, and it never touches your identity, username or
          password.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {scopes.map((s) => (
          <button
            key={s}
            onClick={() =>
              setSelected((sel) => (sel.includes(s) ? sel.filter((x) => x !== s) : [...sel, s]))
            }
            className={`rounded-full px-3 py-1 text-xs ${
              selected.includes(s)
                ? "bg-destructive text-destructive-foreground"
                : "bg-surface-2 text-muted-foreground"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={async () => {
            await clearCacheFn({ data: { token } });
            toast.success("Cache cleared");
          }}
        >
          Clear server cache
        </Button>
        <Button
          variant="destructive"
          disabled={selected.length === 0}
          onClick={() => setConfirming(true)}
        >
          Delete selected
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Delete selected server data?"
        body={`These server records will be permanently deleted for this Guest ID: ${selected.join(", ")}. Your account, username and password are not affected.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await clearDataFn({ data: { token, scopes: selected } });
          setSelected([]);
          setConfirming(false);
          toast.success("Selected data deleted");
        }}
      />
    </div>
  );
}

/**
 * Mega Tournament summary rendered INSIDE the existing USTAD profile.
 * Part 2 does not create a second profile page either.
 */
function MegaProfileStats() {
  const { token } = useGuest();
  const [stats, setStats] = useState<{
    matches: number;
    wins: number;
    losses: number;
    multiplayerWins: number;
    soloWins: number;
    totalCorrect: number;
    bestCorrect: number;
    coinsFromTournament: number;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    void megaProfileStatsFn({ data: { token } })
      .then((r) => setStats(r as never))
      .catch(() => setStats(null));
  }, [token]);

  if (!stats || !stats.matches) return null;
  const rows: Array<[string, string | number]> = [
    ["Matches", stats.matches],
    ["Wins", stats.wins],
    ["Losses", stats.losses],
    ["Multiplayer wins", stats.multiplayerWins],
    ["Single-player wins", stats.soloWins],
    ["Correct answers", stats.totalCorrect],
    ["Best performance", stats.bestCorrect],
    ["USTAD Coins from tournaments", stats.coinsFromTournament.toLocaleString("en-IN")],
  ];
  return (
    <div className="panel mt-4 space-y-2 p-5">
      <Label>Mega Tournament</Label>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Crorepati entry/free-attempt summary, rendered INSIDE the existing profile.
 * Part 3 creates no new profile page either.
 */
function CrorepatiEntryStats() {
  const { token } = useGuest();
  const [stats, setStats] = useState<{
    freeEntries: number;
    maxFreeEntries: number;
    freeEntriesUsed: number;
    paidEntriesUsed: number;
    missedStreak: number;
    missedThreshold: number;
    recoveryCount: number;
    coinsSpentOnEntries: number;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    void crorepatiEntryProfileStatsFn({ data: { token } })
      .then((r) => setStats(r as never))
      .catch(() => setStats(null));
  }, [token]);

  if (!stats) return null;
  const rows: Array<[string, string | number]> = [
    ["Free entries available", `${stats.freeEntries} / ${stats.maxFreeEntries}`],
    ["Free attempts used", stats.freeEntriesUsed],
    ["Paid attempts", stats.paidEntriesUsed],
    ["Missed event streak", `${stats.missedStreak} / ${stats.missedThreshold}`],
    ["Free-entry recoveries", stats.recoveryCount],
    ["USTAD Coins spent on entries", stats.coinsSpentOnEntries.toLocaleString("en-IN")],
  ];
  return (
    <div className="panel mt-4 space-y-2 p-5">
      <Label>Crorepati entries</Label>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
