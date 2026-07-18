import { createQueue, createWorker } from '../../lib/queue'
import { log } from '../../services/logger'
import { applySuggestion, generateKbSuggestions, processCorrection } from './service'

// Queues
export const correctionsQueue = createQueue('corrections')
export const suggestionsQueue = createQueue('suggestions')
export const applySuggestionQueue = createQueue('apply-suggestion')

// Initialize workers
export function initLearningWorkers() {
    log.info({ module: 'learning' }, 'Initializing learning workers')

    createWorker('corrections', async (job) => {
        log.info({ module: 'learning', jobId: job.id }, `Processing correction job: ${job.data.feedbackId}`)
        await processCorrection(BigInt(job.data.feedbackId))
    })

    createWorker('suggestions', async (job) => {
        log.info({ module: 'learning', jobId: job.id }, `Processing generate-suggestions job`)
        const result = await generateKbSuggestions()
        return result
    })

    createWorker('apply-suggestion', async (job) => {
        log.info(
            { module: 'learning', jobId: job.id },
            `Processing apply-suggestion job: ${job.data.suggestionId}`
        )
        await applySuggestion(BigInt(job.data.suggestionId))
    })

    // Setup nightly cron job for generate-kb-suggestions
    suggestionsQueue.add(
        'nightly-generation',
        {},
        {
            repeat: {
                pattern: '0 3 * * *' // Every day at 3:00 AM
            }
        }
    )
}
