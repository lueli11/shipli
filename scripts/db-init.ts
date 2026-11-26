import { sql } from '../src/db.ts';

await sql.file(new URL('../db/schema.sql', import.meta.url).pathname);
console.log('Schema angelegt');
await sql.end();
