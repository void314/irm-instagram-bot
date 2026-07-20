export interface ToolResult {
    success: boolean
    answer: string
    found: boolean
}

export interface Tool {
    name: string
    execute(args: Record<string, unknown>): Promise<ToolResult>
}
