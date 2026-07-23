import { type Job, type Processor, Queue, Worker } from 'bullmq'
import Redis from 'ioredis'

import { env } from '../config/constants'
import { log } from '../services/logger'

// Redis connection shared among queues and workers
const redisConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null // Required by bullmq
})

interface QueueConfig {
    name: string
    processor?: Processor
}

// Registry for queues to allow graceful shutdown
const queues: Record<string, Queue> = {}
const workers: Record<string, Worker> = {}

export function createQueue(name: string): Queue {
    if (!queues[name]) {
        queues[name] = new Queue(name, { connection: redisConnection })
    }
    return queues[name]
}

export function createWorker(name: string, processor: Processor): Worker {
    if (!workers[name]) {
        workers[name] = new Worker(name, processor, { connection: redisConnection })
    }
    return workers[name]
}

export async function shutdownQueues() {
    log.info('Shutting down BullMQ queues and workers...')
    const workerPromises = Object.values(workers).map((w) => w.close())
    const queuePromises = Object.values(queues).map((q) => q.close())
    await Promise.all([...workerPromises, ...queuePromises])
    await redisConnection.quit()
    log.info('BullMQ shutdown complete.')
}
