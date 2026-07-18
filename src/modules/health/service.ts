import { status } from 'elysia'

import { sql } from 'drizzle-orm'

import { db } from '../../db/client'
import type { HealthResponse200, HealthResponse500 } from './model'

export class HealthService {
    public async check() {
        try {
            const isHealthy = await db.execute(sql`SELECT 1 AS ok`)

            if (!isHealthy) {
                return status(500, {
                    status: 'error',
                    message: 'Database is not healthy'
                } as HealthResponse500)
            }
            return {
                status: 'online',
                message: 'Database is healthy',
                data: isHealthy[0] as { ok: 1 }
            } as HealthResponse200
        } catch (error) {
            return status(500, {
                status: 'error',
                message: (error as Error).message
            } as HealthResponse500)
        }
    }
}
