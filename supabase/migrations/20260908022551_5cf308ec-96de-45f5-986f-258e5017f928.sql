ALTER TABLE public.ustad_certificates ALTER COLUMN achievement_id DROP NOT NULL;

CREATE TABLE public.ustad_rank_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_start date NOT NULL,
  cycle_end date NOT NULL,
  category text NOT NULL,
  guest_id text NOT NULL,
  profile_name text NOT NULL DEFAULT '',
  rank integer NOT NULL,
  cup_count integer NOT NULL DEFAULT 0,
  coins bigint NOT NULL DEFAULT 0,
  transaction_id uuid,
  certificate_id text,
  cup_awarded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ustad_rank_awards_unique
  ON public.ustad_rank_awards (cycle_start, category, guest_id);
CREATE INDEX ustad_rank_awards_guest ON public.ustad_rank_awards (guest_id);

GRANT ALL ON public.ustad_rank_awards TO service_role;
ALTER TABLE public.ustad_rank_awards ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.ustad_rank_cycles (
  cycle_start date PRIMARY KEY,
  cycle_end date NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.ustad_rank_cycles TO service_role;
ALTER TABLE public.ustad_rank_cycles ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER update_ustad_rank_awards_updated_at
  BEFORE UPDATE ON public.ustad_rank_awards
  FOR EACH ROW EXECUTE FUNCTION public.tournament_touch_updated_at();