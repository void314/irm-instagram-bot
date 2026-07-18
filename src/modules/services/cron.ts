import Elysia from 'elysia'
import { log } from '../../services/logger'
import { fetchAndUpdateServices } from './sync'

const CRON_INTERVAL = 6 * 60 * 60 * 1000

export const servicesCronController = new Elysia({
    name: 'module.services.cron'
}).onStart(async () => {
    const run = async () => {
        try {
            const result = await fetchAndUpdateServices()
            log.info(
                {
                    module: 'services-cron',
                    added: result.added,
                    updated: result.updated,
                    total: result.total
                },
                '[ServicesCron] prices synced'
            )
        } catch (err) {
            log.error({ module: 'services-cron', error: String(err) }, '[ServicesCron] sync failed')
        }
    }

    await run()
    setInterval(run, CRON_INTERVAL)
    log.info({ module: 'services-cron', interval: `${CRON_INTERVAL / 60000}min` }, '[ServicesCron] started')
})
