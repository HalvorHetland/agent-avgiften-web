/* Anon-nøkkelen hører hjemme i nettleseren — den er offentlig av design, og
 * RLS er det som beskytter dataene. Etterprøvd: anon får HTTP 401 på alle fire
 * tabellene og kan kun sette inn. Se verify/verify-step1.mjs, sjekk 6.
 *
 * OpenAI-nøkkelen er IKKE her og skal aldri være det. Den ligger som secret i
 * Edge-funksjonen. */
const CFG = {
  SUPABASE_URL: "https://fguthicnuasibplfyfrr.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZndXRoaWNudWFzaWJwbGZ5ZnJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MTIyODYsImV4cCI6MjEwMzQ4ODI4Nn0.X_1fon06fY67MUVcwBOLbuyBNoNMzyEjVRHm6RrMZlc",
};
