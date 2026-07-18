import { sql } from 'drizzle-orm'

import { db } from '../../db/client'

export async function findPendingOverrides(query: string): Promise<string[]> {
    // Basic full-text search on pending feedback queries
    const results = await db.execute<{ corrected_response: string }>(
        sql`
            SELECT corrected_response
            FROM response_feedback
            WHERE status = 'pending'
            AND corrected_response IS NOT NULL
            AND to_tsvector('russian', query) @@ plainto_tsquery('russian', ${query})
            LIMIT 3
        `
    )

    return results.map((r) => r.corrected_response)
}
