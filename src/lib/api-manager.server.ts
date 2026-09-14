/** API Manager: per-guest provider credentials, saving, testing, registry state. */
import { requireGuest, db } from "./guest.server";
import { encryptConfig, decryptConfig, maskConfig } from "./crypto.server";
import { getProvider, PROVIDERS } from "./providers";
import { testProvider, missingFields, type TestResult } from "./provider-clients.server";
import type { ConfiguredProvider } from "./router.server";
import { coreKeyConfigured, USTAD_CORE_CHAT_MODEL } from "./ustad-core";
import { freeModelsFor, isFreeModel } from "./free-models";

export async function listConfigs(token: unknown) {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from("api_configs")
    .select(
      "provider,status,status_detail,last_tested_at,models,healthy,latency_ms,config,updated_at",
    )
    .eq("guest_id", guestId);
  if (error) throw new Error(error.message);

  return await Promise.all(
    PROVIDERS.map(async (def) => {
      const row = (data ?? []).find((r) => r.provider === def.id);
      const secretKeys = def.fields.filter((f) => f.secret).map((f) => f.key);
      const models = ((row?.models as string[]) ?? []).filter(Boolean);
      let selectedModel = "";
      if (row) {
        try {
          const cfg = await decryptConfig(row.config as Record<string, unknown>);
          selectedModel = cfg["model"] ?? "";
        } catch {
          selectedModel = "";
        }
      }
      // Only FREE-tier models are ever offered, best quality first.
      const freeModels = freeModelsFor(def.id, models);
      return {
        provider: def.id,
        status: row?.status ?? "not_configured",
        statusDetail: row?.status_detail ?? null,
        lastTestedAt: row?.last_tested_at ?? null,
        models,
        freeModels,
        selectedModel,
        defaultModel: freeModels[0] ?? "",
        healthy: row?.healthy ?? null,
        latencyMs: row?.latency_ms ?? null,
        filled: row ? maskConfig(row.config as Record<string, unknown>, secretKeys) : {},
      };
    }),
  );
}

/**
 * Persist the user's model choice for a provider.
 * `""` = Default (best active free model, resolved dynamically at call time).
 * A paid-only / unreported model is rejected — never silently accepted.
 */
export async function setModel(token: unknown, provider: string, model: string) {
  const guestId = await requireGuest(token);
  const def = getProvider(provider);
  if (!def) throw new Error("Unknown provider");

  const { data: row } = await db()
    .from("api_configs")
    .select("config,models")
    .eq("guest_id", guestId)
    .eq("provider", provider)
    .maybeSingle();
  if (!row) throw new Error("This provider is not configured yet.");

  const wanted = model.trim();
  if (wanted) {
    const live = ((row.models as string[]) ?? []).filter(Boolean);
    if (live.length && !live.includes(wanted)) {
      throw new Error("That model is not available on your account.");
    }
    if (!isFreeModel(provider, wanted)) {
      throw new Error("Only free-tier models can be selected.");
    }
  }

  const current = await decryptConfig(row.config as Record<string, unknown>);
  if (wanted) current["model"] = wanted;
  else delete current["model"];

  const { error } = await db()
    .from("api_configs")
    .update({ config: await encryptConfig(current), updated_at: new Date().toISOString() })
    .eq("guest_id", guestId)
    .eq("provider", provider);
  if (error) throw new Error(error.message);
  return { selectedModel: wanted };
}

export async function saveConfig(token: unknown, provider: string, config: Record<string, string>) {
  const guestId = await requireGuest(token);
  const def = getProvider(provider);
  if (!def) throw new Error("Unknown provider");

  const { data: existing } = await db()
    .from("api_configs")
    .select("config")
    .eq("guest_id", guestId)
    .eq("provider", provider)
    .maybeSingle();

  const current = await decryptConfig((existing?.config as Record<string, unknown>) ?? {});
  // Only overwrite fields the user actually submitted (partial configuration).
  for (const [k, v] of Object.entries(config)) {
    if (v === "") delete current[k];
    else if (v && v !== "••••••••") current[k] = v.trim();
  }
  const missing = missingFields(def, current);
  const status = missing.length ? "missing_field" : "saved_not_tested";

  const { error } = await db()
    .from("api_configs")
    .upsert(
      {
        guest_id: guestId,
        provider,
        config: await encryptConfig(current),
        status,
        status_detail: missing.length ? `Missing: ${missing.join(", ")}` : "Saved. Not tested yet.",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "guest_id,provider" },
    );
  if (error) throw new Error(error.message);
  return { status, missing };
}

export async function testConfig(token: unknown, provider: string): Promise<TestResult> {
  const guestId = await requireGuest(token);
  const def = getProvider(provider);
  if (!def) throw new Error("Unknown provider");

  const { data: row } = await db()
    .from("api_configs")
    .select("config")
    .eq("guest_id", guestId)
    .eq("provider", provider)
    .maybeSingle();
  if (!row) throw new Error("This provider is not configured yet.");

  const config = await decryptConfig(row.config as Record<string, unknown>);
  const result = await testProvider(provider, config);

  await db()
    .from("api_configs")
    .update({
      status: result.status,
      status_detail: result.detail,
      last_tested_at: new Date().toISOString(),
      healthy: result.status === "connected",
      latency_ms: result.latencyMs,
      ...(result.models ? { models: result.models } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("guest_id", guestId)
    .eq("provider", provider);

  return result;
}

export async function deleteConfig(token: unknown, provider: string) {
  const guestId = await requireGuest(token);
  const { error } = await db()
    .from("api_configs")
    .delete()
    .eq("guest_id", guestId)
    .eq("provider", provider);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/** Server-internal: decrypted, usable providers for the router. */
export async function usableProviders(guestId: string): Promise<ConfiguredProvider[]> {
  const { data } = await db()
    .from("api_configs")
    .select("provider,config,models,healthy,status")
    .eq("guest_id", guestId);
  const out: ConfiguredProvider[] = [];
  // Bug 21: isolate each provider so one corrupt/expired config can never
  // prevent healthy providers from being discovered/used.
  for (const row of data ?? []) {
    try {
      if (row.status === "missing_field" || row.status === "not_configured") continue;
      const def = getProvider(row.provider);
      if (!def) continue;
      let config: Record<string, string>;
      try {
        config = await decryptConfig(row.config as Record<string, unknown>);
      } catch {
        // Corrupt/undecryptable config — skip just this provider.
        continue;
      }
      if (missingFields(def, config).length) continue;
      out.push({
        provider: row.provider,
        config,
        // Keep the full model list so routing can pick by MODEL capability (Bug 20),
        // not just the first model of a provider that "has vision".
        models: ((row.models as string[]) ?? []).filter(Boolean),
        healthy: row.healthy,
      });
    } catch {
      // Never let one provider break discovery of the rest.
      continue;
    }
  }
  return out;
}

/**
 * Built-in USTAD Core AI. Only advertised when the gateway key is present.
 * Health is UNKNOWN until a real call succeeds — never hardcoded "healthy".
 */
export function coreProvider(): ConfiguredProvider | null {
  if (!coreKeyConfigured()) return null;
  return {
    provider: "ustad-core",
    config: {},
    models: [USTAD_CORE_CHAT_MODEL],
    healthy: null,
  };
}

export function coreCandidates(): ConfiguredProvider[] {
  const core = coreProvider();
  return core ? [core] : [];
}
