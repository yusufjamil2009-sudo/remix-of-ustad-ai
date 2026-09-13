REVOKE EXECUTE ON FUNCTION public.ustad_ticket_grant(text, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ustad_ticket_consume(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ustad_ticket_grant(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.ustad_ticket_consume(text) TO service_role;