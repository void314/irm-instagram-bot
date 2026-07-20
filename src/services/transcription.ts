import { env } from '../config/constants'
import { log } from './logger'
import type { MultimodalContent } from './llm/openrouter'
import { chat } from './llm/openrouter'

function detectFormat(url: string, contentType: string | null): string {
    if (contentType) {
        const ct = contentType.toLowerCase()
        if (ct.includes('ogg')) return 'ogg'
        if (ct.includes('wav')) return 'wav'
        if (ct.includes('webm')) return 'webm'
        if (ct.includes('mp4')) return 'mp4'
        if (ct.includes('aac')) return 'aac'
        if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3'
        if (ct.includes('m4a')) return 'm4a'
    }
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase()
    if (ext && ['mp3', 'mp4', 'm4a', 'ogg', 'wav', 'webm', 'aac'].includes(ext)) {
        return ext
    }
    return 'mp3'
}

export async function transcribeAudio(
    audioUrl: string,
    pageAccessToken: string
): Promise<string> {
    const audioResponse = await fetch(audioUrl, {
        headers: { Authorization: `Bearer ${pageAccessToken}` }
    })

    if (!audioResponse.ok) {
        throw new Error(`Audio download failed: ${audioResponse.status} ${audioResponse.statusText}`)
    }

    const audioBuffer = await audioResponse.arrayBuffer()
    const contentType = audioResponse.headers.get('content-type')
    const format = detectFormat(audioUrl, contentType)

    log.debug(
        { module: 'transcription', format, sizeBytes: audioBuffer.byteLength },
        'Audio downloaded'
    )

    const apiKey = env.OPENROUTER_API_KEY
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not set')
    }

    const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: env.TRANSCRIPTION_MODEL,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Transcribe this voice message exactly as spoken. Return only the transcribed text, nothing else. Preserve the original language.'
                        },
                        {
                            type: 'input_audio',
                            input_audio: {
                                data: Buffer.from(audioBuffer).toString('base64'),
                                format
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1024,
            temperature: 0
        })
    })

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Transcription API error ${response.status}: ${text.slice(0, 300)}`)
    }

    const data = (await response.json()) as {
        choices?: { message?: { content?: string | null } }[]
    }
    const transcript = data.choices?.[0]?.message?.content

    if (!transcript) {
        throw new Error('Empty transcription response from API')
    }

    return transcript.trim()
}

export async function describeImage(
    imageUrl: string,
    pageAccessToken: string
): Promise<string> {
    const response = await fetch(imageUrl, {
        headers: { Authorization: `Bearer ${pageAccessToken}` }
    })

    if (!response.ok) {
        throw new Error(`Image download failed: ${response.status} ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    const contentType = response.headers.get('content-type') || 'image/jpeg'

    log.debug(
        { module: 'vision', contentType, sizeBytes: buffer.byteLength },
        'Image downloaded'
    )

    const content: MultimodalContent[] = [
        {
            type: 'text',
            text: 'Describe what is shown in this image in detail. Be specific about what you see.'
        },
        {
            type: 'image_url',
            image_url: {
                url: `data:${contentType};base64,${Buffer.from(buffer).toString('base64')}`
            }
        }
    ]

    const result = await chat(
        [{ role: 'user', content }],
        { model: env.VISION_MODEL, max_tokens: 512, temperature: 0.3 }
    )

    return result.content.trim()
}
