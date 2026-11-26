export async function register() {
  // nur im Node-Server, nicht im Edge-Runtime und nicht während next build
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { SHIPLI_ADMIN_EMAIL: email, SHIPLI_ADMIN_PASSWORD: password } = process.env;
  if (email && password) {
    const { createFirstAdmin } = await import('./src/auth.ts');
    if (await createFirstAdmin(email, 'admin', password)) console.log(`Erster Admin angelegt: ${email}`);
  }
  if (process.env.SHIPLI_METRICS === 'off') return;
  const { startCollector } = await import('./src/metrics.ts');
  startCollector();
}
