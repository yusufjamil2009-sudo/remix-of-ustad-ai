/**
 * Generates baseline DDL for the PRE-EXISTING USTAD AI tables from the
 * committed Supabase type definitions (src/integrations/supabase/types.ts).
 *
 * Those tables were created before the Part 1–6 migrations, on the hosted
 * project, so their DDL is not in supabase/migrations. This reconstructs them
 * for a local PostgreSQL test instance so that the REAL Part 1–6 migrations can
 * be applied on top and exercised against a real database with real
 * constraints, foreign keys and unique indexes.
 *
 * Only the baseline is reconstructed. Every Part 1–6 table comes from the
 * actual committed migration files, unmodified.
 */
import fs from "node:fs";

const src = fs.readFileSync("src/integrations/supabase/types.ts", "utf8");

// Slice out the Tables: { ... } block.
const start = src.indexOf("    Tables: {");
const body = src.slice(start);

const tables = [];
const re = /^      (\w+): \{\n        Row: \{\n([\s\S]*?)\n        \}\n        Insert:/gm;
let m;
while ((m = re.exec(body))) tables.push({ name: m[1], rows: m[2] });

function sqlType(name, tsType) {
  const t = tsType.replace(/\s*\|\s*null/g, "").trim();
  if (name === "id" && t === "string") return "text";
  if (t === "number") return "numeric";
  if (t === "boolean") return "boolean";
  if (t === "Json" || t.startsWith("{") || t.includes("[]")) return "jsonb";
  return "text";
}

const out = [];
out.push("-- Auto-generated baseline for pre-existing USTAD AI tables (test only).");
out.push("create extension if not exists pgcrypto;");

for (const { name, rows } of tables) {
  const cols = [];
  for (const line of rows.split("\n")) {
    const cm = line.match(/^\s{10}(\w+)(\??):\s*(.+?)$/);
    if (!cm) continue;
    const [, col, , rawType] = cm;
    const nullable = /\|\s*null/.test(rawType);
    let type = sqlType(col, rawType);
    let def = "";
    if (col === "id" && type === "text") {
      // uuid-shaped ids stay uuid; text ids (guests) stay text.
      type = name === "guests" ? "text" : "uuid";
      def = type === "uuid" ? " default gen_random_uuid()" : "";
      cols.push(`  "${col}" ${type}${def} primary key`);
      continue;
    }
    if (/_at$/.test(col)) type = "timestamptz";
    if (type === "jsonb") def = " default '{}'::jsonb";
    if (type === "boolean") def = " default false";
    if (col === "created_at" || col === "updated_at") def = " default now()";
    cols.push(`  "${col}" ${type}${def}${nullable ? "" : ""}`);
  }
  if (!cols.length) continue;
  out.push(`create table if not exists public.${name} (\n${cols.join(",\n")}\n);`);
}

// The Part 1–6 migrations reference these as foreign keys / conflict targets.
out.push(`alter table public.profiles add constraint profiles_guest_uniq unique (guest_id);`);
out.push(`alter table public.settings add constraint settings_guest_uniq unique (guest_id);`);
out.push(
  `alter table public.api_configs add constraint api_configs_guest_provider_uniq unique (guest_id, provider);`,
);

fs.writeFileSync("/tmp/baseline.sql", out.join("\n\n") + "\n");
console.log(`wrote ${tables.length} baseline tables to /tmp/baseline.sql`);
