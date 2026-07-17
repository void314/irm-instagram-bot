import { db } from '../../db/client'
import { accounts } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/constants'
import { encryptToken, decryptToken } from '../../lib/encryption'

const FB_GRAPH_URL = 'https://graph.facebook.com/v25.0'

export class TokenService {
    async getDecryptedToken(igId: string): Promise<string | null> {
        const row = await db
            .select({
                tokenEncrypted: accounts.tokenEncrypted,
                tokenIv: accounts.tokenIv
            })
            .from(accounts)
            .where(eq(accounts.igId, igId))
            .then((rows) => rows[0])

        if (!row?.tokenEncrypted || !row?.tokenIv) return null

        return decryptToken(row.tokenEncrypted, row.tokenIv)
    }

    async saveToken(
        igId: string,
        username: string | null,
        accessToken: string,
        expiresAt: Date | null
    ): Promise<void> {
        const { ciphertext, iv } = await encryptToken(accessToken)

        await db
            .insert(accounts)
            .values({
                igId,
                username,
                tokenEncrypted: ciphertext,
                tokenIv: iv,
                tokenExpiresAt: expiresAt,
                lastRefreshAt: new Date()
            })
            .onConflictDoUpdate({
                target: accounts.igId,
                set: {
                    username,
                    tokenEncrypted: ciphertext,
                    tokenIv: iv,
                    tokenExpiresAt: expiresAt,
                    lastRefreshAt: new Date(),
                    refreshError: null
                }
            })
    }

    async needsRefresh(igId: string): Promise<boolean> {
        const row = await db
            .select({ tokenExpiresAt: accounts.tokenExpiresAt })
            .from(accounts)
            .where(eq(accounts.igId, igId))
            .then((rows) => rows[0])

        if (!row?.tokenExpiresAt) return true

        const sevenDaysFromNow = new Date()
        sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)

        return row.tokenExpiresAt < sevenDaysFromNow
    }

    async refreshToken(igId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const currentToken = await this.getDecryptedToken(igId)
            if (!currentToken) {
                return { success: false, error: 'No token found for account' }
            }

            if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) {
                return { success: false, error: 'FACEBOOK_APP_ID or FACEBOOK_APP_SECRET not configured' }
            }

            const url = new URL(`${FB_GRAPH_URL}/oauth/access_token`)
            url.searchParams.set('grant_type', 'fb_exchange_token')
            url.searchParams.set('client_id', env.FACEBOOK_APP_ID)
            url.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET)
            url.searchParams.set('fb_exchange_token', currentToken)

            const res = await fetch(url)
            const data = (await res.json()) as {
                access_token?: string
                expires_in?: number
                error?: { message?: string }
            }

            if (!res.ok || !data.access_token) {
                const msg = data.error?.message || 'Token refresh failed'
                await db
                    .update(accounts)
                    .set({ refreshError: msg, lastRefreshAt: new Date() })
                    .where(eq(accounts.igId, igId))
                return { success: false, error: msg }
            }

            const expiresAt = data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000)
                : null

            const { ciphertext, iv } = await encryptToken(data.access_token)
            await db
                .update(accounts)
                .set({
                    tokenEncrypted: ciphertext,
                    tokenIv: iv,
                    tokenExpiresAt: expiresAt,
                    lastRefreshAt: new Date(),
                    refreshError: null
                })
                .where(eq(accounts.igId, igId))

            return { success: true }
        } catch (err) {
            const msg = String(err)
            await db
                .update(accounts)
                .set({ refreshError: msg, lastRefreshAt: new Date() })
                .where(eq(accounts.igId, igId))
            return { success: false, error: msg }
        }
    }

    async refreshAllActive(): Promise<{ refreshed: number; failed: number; errors: string[] }> {
        const all = await db
            .select({ igId: accounts.igId })
            .from(accounts)

        let refreshed = 0
        let failed = 0
        const errors: string[] = []

        for (const acc of all) {
            const needs = await this.needsRefresh(acc.igId)
            if (!needs) continue

            const result = await this.refreshToken(acc.igId)
            if (result.success) {
                refreshed++
            } else {
                failed++
                errors.push(`${acc.igId}: ${result.error}`)
            }
        }

        return { refreshed, failed, errors }
    }
}
