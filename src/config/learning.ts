// In-memory toggle for learning features (could be moved to DB)
export let isLearningEnabled = true

export function toggleLearning(enabled: boolean) {
    isLearningEnabled = enabled
}
