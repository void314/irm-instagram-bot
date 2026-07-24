import { log } from '../logger'

const SCORE_THRESHOLD = 0.25

export interface GroundingResult {
    passed: boolean
}

export interface ChunkWithScore {
    text: string
    score: number
}

export function checkGrounding(chunks: ChunkWithScore[]): GroundingResult {
    if (chunks.length === 0) {
        log.debug({ module: 'grounding', reason: 'no_chunks' }, 'Grounding: pass (no chunks to check)')
        return { passed: true }
    }

    const maxScore = Math.max(...chunks.map((c) => c.score))

    if (maxScore >= SCORE_THRESHOLD) {
        log.debug({ module: 'grounding', maxScore: maxScore.toFixed(3), threshold: SCORE_THRESHOLD }, 'Grounding: passed')
        return { passed: true }
    }

    log.info(
        {
            module: 'grounding',
            maxScore: maxScore.toFixed(3),
            threshold: SCORE_THRESHOLD
        },
        'Grounding: failed'
    )

    return { passed: false }
}
