CREATE TABLE public.tournament_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id text NOT NULL REFERENCES public.guests(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mystery','god')),
  cycle_id text NOT NULL,
  cycle_start timestamptz,
  cycle_end timestamptz,
  attempt_date date NOT NULL,
  language text NOT NULL DEFAULT 'english',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  total_questions int NOT NULL DEFAULT 20,
  current_index int NOT NULL DEFAULT 0,
  correct_count int NOT NULL DEFAULT 0,
  wrong_count int NOT NULL DEFAULT 0,
  score int NOT NULL DEFAULT 0,
  result text NOT NULL DEFAULT '' CHECK (result IN ('','WIN','LOSS')),
  entry_txn_id text NOT NULL DEFAULT '',
  entry_amount bigint NOT NULL DEFAULT 0,
  ticket_consumed boolean NOT NULL DEFAULT false,
  reward_issued boolean NOT NULL DEFAULT false,
  reward_txn_id text NOT NULL DEFAULT '',
  coins_awarded bigint NOT NULL DEFAULT 0,
  achievement_id uuid,
  certificate_id text NOT NULL DEFAULT '',
  certificate_url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.tournament_attempts TO service_role;
ALTER TABLE public.tournament_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages tournament attempts" ON public.tournament_attempts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE UNIQUE INDEX tournament_attempt_one_per_day ON public.tournament_attempts (guest_id, kind, attempt_date);
CREATE UNIQUE INDEX tournament_attempt_god_weekly ON public.tournament_attempts (guest_id, cycle_id) WHERE kind = 'god';
CREATE INDEX tournament_attempt_cycle_idx ON public.tournament_attempts (kind, cycle_id, result);
CREATE INDEX tournament_attempt_guest_idx ON public.tournament_attempts (guest_id, kind, created_at DESC);

CREATE TABLE public.tournament_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.tournament_attempts(id) ON DELETE CASCADE,
  position int NOT NULL,
  prompt text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  correct_index int NOT NULL DEFAULT 0,
  explanation text NOT NULL DEFAULT '',
  solution text NOT NULL DEFAULT '',
  difficulty text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  selected_index int,
  is_correct boolean,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.tournament_questions TO service_role;
ALTER TABLE public.tournament_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages tournament questions" ON public.tournament_questions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE UNIQUE INDEX tournament_question_position ON public.tournament_questions (attempt_id, position);

CREATE TABLE public.ustad_tickets (
  guest_id text PRIMARY KEY REFERENCES public.guests(id) ON DELETE CASCADE,
  god_tickets int NOT NULL DEFAULT 0 CHECK (god_tickets >= 0),
  lifetime_purchased int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.ustad_tickets TO service_role;
ALTER TABLE public.ustad_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages tickets" ON public.ustad_tickets FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.ustad_ticket_grant(p_guest_id text, p_amount int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_after int;
BEGIN
  INSERT INTO public.ustad_tickets (guest_id, god_tickets, lifetime_purchased)
  VALUES (p_guest_id, GREATEST(p_amount, 0), GREATEST(p_amount, 0))
  ON CONFLICT (guest_id) DO UPDATE
    SET god_tickets = public.ustad_tickets.god_tickets + GREATEST(p_amount, 0),
        lifetime_purchased = public.ustad_tickets.lifetime_purchased + GREATEST(p_amount, 0),
        updated_at = now()
  RETURNING god_tickets INTO v_after;
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.ustad_ticket_consume(p_guest_id text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_after int;
BEGIN
  UPDATE public.ustad_tickets
     SET god_tickets = god_tickets - 1, updated_at = now()
   WHERE guest_id = p_guest_id AND god_tickets > 0
  RETURNING god_tickets INTO v_after;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_TICKET';
  END IF;
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.tournament_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_tournament_attempts_updated_at
BEFORE UPDATE ON public.tournament_attempts
FOR EACH ROW EXECUTE FUNCTION public.tournament_touch_updated_at();