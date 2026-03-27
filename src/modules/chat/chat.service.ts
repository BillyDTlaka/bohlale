import Anthropic from '@anthropic-ai/sdk'
import { buildSnapshot } from '../board/board.context'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })
const MODEL = 'claude-sonnet-4-6'

const SYSTEM_BASE = `
You are Bohlale — the AI business assistant for Tlaka Treats, a small South African food business producing handmade baked goods sold via an ambassador/reseller network and direct customers.

Your purpose is to help the business owner understand their business, answer questions about their data, and provide practical, actionable advice.

Rules:
- Always use South African Rand with the "R" symbol (e.g. R1,500). Never use "$".
- Be specific. When data is available, reference actual numbers.
- Be concise and direct — the owner is busy. No corporate jargon.
- If the question is about something not in the data, say so clearly and offer what you do know.
- You may give opinions and recommendations — you are an advisor, not just a search tool.
- Format responses with markdown where it helps readability (bullet points, bold key figures).
`.trim()

export function buildSystemPrompt(snapshot: any, docs: any[]): string {
  const parts = [SYSTEM_BASE]

  if (snapshot && Object.keys(snapshot).length) {
    parts.push(`\n\n## Current Business Data (last ${snapshot.business?.periodDays || 30} days)\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\``)
  }

  if (docs.length) {
    parts.push(`\n\n## Knowledge Documents\nThe following company documents are available for reference:`)
    docs.forEach(d => {
      parts.push(`\n### ${d.name}${d.description ? ` — ${d.description}` : ''}\n${d.content}`)
    })
  }

  return parts.join('')
}

export async function streamChatReply(
  db: any,
  conversationId: string,
  userContent: string,
  onChunk: (text: string) => void
): Promise<string> {
  // Get conversation history (last 20 messages)
  const history = await db.chatMessage.findMany({
    where:   { conversationId },
    orderBy: { createdAt: 'asc' },
    take:    20,
  })

  // Get all knowledge documents
  const docs = await db.knowledgeDocument.findMany({
    orderBy: { createdAt: 'desc' },
  })

  // Get compact business snapshot
  let snapshot: any = {}
  try {
    snapshot = await buildSnapshot(db, 30)
  } catch {}

  const systemPrompt = buildSystemPrompt(snapshot, docs)

  // Build messages array from history
  const messages: { role: 'user' | 'assistant'; content: string }[] = history.map((m: any) => ({
    role:    m.role as 'user' | 'assistant',
    content: m.content,
  }))
  messages.push({ role: 'user', content: userContent })

  // Stream the response
  let fullText = ''

  const stream = await client.messages.create({
    model:     MODEL,
    max_tokens: 2000,
    system:    systemPrompt,
    messages,
    stream:    true,
  })

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      const chunk = event.delta.text
      fullText += chunk
      onChunk(chunk)
    }
  }

  return fullText
}
