import postgres from 'postgres';

// verbindet erst bei der ersten Abfrage; global, damit next dev beim Neuladen keine Verbindungen stapelt
const g = globalThis as { shipliSql?: postgres.Sql };
export const sql = (g.shipliSql ??= postgres(process.env.DATABASE_URL as string, { onnotice: () => {} }));
