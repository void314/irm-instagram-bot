import { sql } from 'drizzle-orm'

import { db } from '../../db/client'
import type { HealthResponse200, HealthResponse500 } from './model'

export class HealthService {
    public async check(): Promise<HealthResponse200 | HealthResponse500> {
        try {
            const isHealthy = await db.execute(sql`SELECT 1 AS ok`)

            if (!isHealthy) {
                return {
                    status: 'error',
                    message: 'Database is not healthy'
                }
            }
            return { status: 'online', message: 'Database is healthy', data: isHealthy[0] as { ok: 1 } }
        } catch (error) {
            return {
                status: 'error',
                message: (error as Error).message
            }
        }
    }
}
