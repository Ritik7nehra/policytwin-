import { writeFileSync } from 'node:fs';
import { buildSchemaSql } from '../src/lib/store/tables';

writeFileSync(new URL('../db/schema.sql', import.meta.url), buildSchemaSql());
console.log('wrote db/schema.sql');
