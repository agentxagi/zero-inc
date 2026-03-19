import { db } from '../packages/db/src/index.js';
import { issues } from '../packages/db/src/schema/issues.js';
import { eq } from 'drizzle-orm';

const issueId = '29c6f9d4-af6f-4daf-814b-e742703b69f0';

async function main() {
  const result = await db
    .update(issues)
    .set({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issueId))
    .returning();

  console.log('Cleared stale lock:', JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
