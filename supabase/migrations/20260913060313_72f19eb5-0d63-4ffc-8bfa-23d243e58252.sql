CREATE TABLE public.device_ai_batches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  guest_id UUID NOT NULL,
  task TEXT NOT NULL,
  raw TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX device_ai_batches_guest_task_idx ON public.device_ai_batches (guest_id, task, created_at DESC);
GRANT ALL ON public.device_ai_batches TO service_role;
ALTER TABLE public.device_ai_batches ENABLE ROW LEVEL SECURITY;