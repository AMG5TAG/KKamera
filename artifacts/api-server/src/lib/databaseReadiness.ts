export interface SchemaColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
}

/**
 * Publishing owns schema changes on the managed database. Startup only checks
 * that the application's required tables/columns exist; it never executes DDL.
 */
export async function verifyDatabaseSchema(
  query: (sql: string) => Promise<{ rows: SchemaColumn[] }>,
  expected: SchemaColumn[],
): Promise<void> {
  if (expected.length === 0) throw new Error("No database schema columns configured");
  const { rows } = await query(
    "SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  const key = (column: SchemaColumn) =>
    `${column.table_schema}.${column.table_name}.${column.column_name}`;
  const actual = new Set(rows.map(key));
  const missing = expected.filter((column) => !actual.has(key(column)));
  if (missing.length) {
    throw new Error(`Database schema is missing required columns: ${missing.map(key).join(", ")}. Apply development schema changes through Publish.`);
  }
}
