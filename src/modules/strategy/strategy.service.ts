import Anthropic from '@anthropic-ai/sdk'
import { buildSnapshot } from '../board/board.context'
import { AppError } from '../../shared/errors'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })
const MODEL = 'claude-sonnet-4-6'

// ── JSON output schema injected into prompt ───────────────────────────────────
const CONTENT_SCHEMA = `
{
  "executiveSummary": "string (2-3 sentences)",
  "vision": "string (one sentence — the 3-year aspiration)",
  "mission": "string (one sentence — what the business does and for whom)",
  "coreValues": [
    { "value": "string", "description": "string (one sentence)" }
  ],
  "swot": {
    "strengths":     ["string (cite specific data where possible)"],
    "weaknesses":    ["string"],
    "opportunities": ["string"],
    "threats":       ["string"]
  },
  "strategicGoals": [
    {
      "goal":      "string",
      "timeframe": "string (e.g. 6 months, 12 months)",
      "owner":     "string (e.g. CEO, Operations)",
      "priority":  "HIGH|MEDIUM|LOW",
      "kpis": [
        { "metric": "string", "current": "string", "target": "string" }
      ],
      "initiatives": ["string"]
    }
  ],
  "actionPlan90Days": [
    {
      "week":    "string (e.g. Week 1-2)",
      "actions": ["string"],
      "owner":   "string"
    }
  ],
  "financialTargets": [
    { "metric": "string", "current": "string", "target": "string", "by": "string" }
  ],
  "riskRegister": [
    {
      "risk":        "string",
      "likelihood":  "HIGH|MEDIUM|LOW",
      "impact":      "HIGH|MEDIUM|LOW",
      "mitigation":  "string",
      "owner":       "string"
    }
  ]
}
`.trim()

const BASE_SYSTEM = `
You are an expert business strategist specialising in South African small businesses.
The business is Tlaka Treats — a small food business producing handmade baked goods sold via an ambassador/reseller network and direct customers in South Africa.
Currency is ZAR. Always use "R" as the symbol (e.g. R1,500). Never use "$".
The team is 1-5 people. All recommendations must be executable with limited resources.
Respond ONLY with valid JSON — no prose, no markdown, no code fences.
Be specific and data-driven. Reference actual numbers from the data provided.
`.trim()

// ── Defensive JSON parser (same pattern as board.service.ts) ─────────────────
function parseJson(text: string): any {
  const clean = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
  try { return JSON.parse(clean) } catch {}
  let pos = 0
  while (true) {
    const start = clean.indexOf('{', pos)
    if (start === -1) break
    let end = clean.lastIndexOf('}')
    while (end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)) } catch {}
      end = clean.lastIndexOf('}', end - 1)
    }
    pos = start + 1
  }
  console.error('[strategy] parseJson failed. Raw (500):', text.slice(0, 500))
  return {}
}

// ── Generation (runs in background) ──────────────────────────────────────────
export async function generateStrategy(db: any, strategyId: string) {
  try {
    const strategy = await db.strategy.findUnique({ where: { id: strategyId } })
    if (!strategy) return

    const context = strategy.contextJson as any
    const snapshot = await buildSnapshot(db, 90)

    await db.strategy.update({
      where: { id: strategyId },
      data:  { snapshotJson: snapshot as any },
    })

    const contextBlock = Object.keys(context).length
      ? `\nOwner-provided context:\n${JSON.stringify(context, null, 2)}`
      : '\nNo additional context provided — generate entirely from the business data.'

    const prompt = `Business data snapshot (90-day window, currency ZAR):
${JSON.stringify(snapshot, null, 2)}
${contextBlock}

Strategy title: "${strategy.title}"

Generate a complete, realistic business strategy for Tlaka Treats based on this data.
Rules:
- Max 4 strategic goals
- Max 6 action plan entries (group by 2-week sprints)
- Max 5 financial targets
- Max 5 risks in the risk register
- Max 4 core values
- Every SWOT item must have at most 4 entries per quadrant
- Be ambitious but achievable for a 1-5 person team
- Reference specific metrics from the snapshot (revenue figures, product names, stock levels)

Output ONLY valid JSON matching this schema exactly:
${CONTENT_SCHEMA}`

    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 8000,
      system:     BASE_SYSTEM,
      messages:   [{ role: 'user', content: prompt }],
    })

    const rawText = response.content[0]?.type === 'text' ? response.content[0].text : '{}'
    console.log(`[strategy] generate stop_reason=${response.stop_reason} tokens=${response.usage?.output_tokens}`)

    const content = parseJson(rawText)
    const newVersion = 1

    await db.strategyRevision.create({
      data: {
        strategyId:  strategyId,
        version:     newVersion,
        contentJson: content,
        changeType:  'AI_GENERATED',
        changeNote:  'Initial AI generation',
      },
    })

    await db.strategy.update({
      where: { id: strategyId },
      data:  {
        status:         'DRAFT',
        contentJson:    content,
        currentVersion: newVersion,
      },
    })
  } catch (err: any) {
    console.error('[strategy] generateStrategy error:', err?.message)
    await db.strategy.update({
      where: { id: strategyId },
      data:  { status: 'GENERATING', errorMessage: err?.message || 'Generation failed' },
    }).catch(() => {})
    // Set to a FAILED-like state — reuse DRAFT with error message so UI can show it
    await db.strategy.update({
      where: { id: strategyId },
      data:  { status: 'DRAFT', errorMessage: err?.message || 'Generation failed' },
    }).catch(() => {})
  }
}

// ── Refinement (runs in background) ──────────────────────────────────────────
export async function refineStrategy(db: any, strategyId: string, prompt: string) {
  try {
    const strategy = await db.strategy.findUnique({ where: { id: strategyId } })
    if (!strategy) return

    const currentContent = JSON.stringify(strategy.contentJson, null, 2)

    const refinementPrompt = `Current strategy (JSON):
${currentContent}

Refinement instruction: ${prompt}

Update the strategy based on this instruction. You MUST:
- Return the COMPLETE strategy JSON (all sections, even unchanged ones)
- Keep the same JSON schema
- Incorporate the refinement thoughtfully

Output ONLY valid JSON matching this schema exactly:
${CONTENT_SCHEMA}`

    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 8000,
      system:     BASE_SYSTEM,
      messages:   [{ role: 'user', content: refinementPrompt }],
    })

    const rawText = response.content[0]?.type === 'text' ? response.content[0].text : '{}'
    console.log(`[strategy] refine stop_reason=${response.stop_reason} tokens=${response.usage?.output_tokens}`)

    const updated = parseJson(rawText)
    if (!updated || !updated.vision) {
      throw new Error('AI returned empty or invalid strategy JSON')
    }

    const newVersion = (strategy.currentVersion || 0) + 1

    await db.strategyRevision.create({
      data: {
        strategyId:  strategyId,
        version:     newVersion,
        contentJson: updated,
        changeType:  'AI_REFINED',
        changeNote:  prompt,
      },
    })

    await db.strategy.update({
      where: { id: strategyId },
      data:  {
        contentJson:    updated,
        currentVersion: newVersion,
        errorMessage:   null,
      },
    })
  } catch (err: any) {
    console.error('[strategy] refineStrategy error:', err?.message)
    // Don't overwrite the strategy on refinement failure — just log it
  }
}

// ── Manual content save ───────────────────────────────────────────────────────
export async function saveStrategyContent(
  db: any,
  strategyId: string,
  patch: { section?: string; data?: any; contentJson?: any },
  changeNote?: string
) {
  const strategy = await db.strategy.findUnique({ where: { id: strategyId } })
  if (!strategy) throw new AppError('Strategy not found', 404, 'NOT_FOUND')

  let newContent: any
  if (patch.contentJson) {
    newContent = patch.contentJson
  } else if (patch.section && patch.data !== undefined) {
    newContent = { ...(strategy.contentJson as any), [patch.section]: patch.data }
  } else {
    throw new AppError('Provide either contentJson or section+data', 400, 'INVALID_BODY')
  }

  const newVersion = (strategy.currentVersion || 0) + 1

  await db.strategyRevision.create({
    data: {
      strategyId:  strategyId,
      version:     newVersion,
      contentJson: newContent,
      changeType:  'MANUAL_EDIT',
      changeNote:  changeNote ?? (patch.section ? `Edited: ${patch.section}` : 'Manual edit'),
    },
  })

  return db.strategy.update({
    where: { id: strategyId },
    data:  { contentJson: newContent, currentVersion: newVersion },
  })
}

// ── Status transition validation ──────────────────────────────────────────────
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT:             ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW:         ['APPROVED', 'CHANGES_REQUESTED', 'ARCHIVED'],
  CHANGES_REQUESTED: ['DRAFT', 'ARCHIVED'],
  APPROVED:          ['ARCHIVED'],
}

export function validateTransition(from: string, to: string) {
  const allowed = VALID_TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    throw new AppError(
      `Cannot transition from ${from} to ${to}`,
      400,
      'INVALID_TRANSITION'
    )
  }
}
