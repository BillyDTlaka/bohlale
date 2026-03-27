import Anthropic from '@anthropic-ai/sdk'
import { BusinessSnapshot } from './board.context'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })

const AGENT_MODEL = 'claude-haiku-4-5-20251001'
const SYNTH_MODEL = 'claude-sonnet-4-6'

// ── Shared base ────────────────────────────────────────────────────────────────
const BASE_RULES = `
You are an AI advisor in a board meeting for a small business based in South Africa.
The business operates in South African Rand (ZAR). Always use "R" as the currency symbol (e.g. R250, R1,500). Never use "$" or any other currency symbol.
Respond ONLY with valid JSON — no prose, no markdown, no code fences.
Be specific and data-driven. Reference actual numbers from the data.
Keep recommendations achievable for a small team with limited resources.
`.trim()

const OUTPUT_SCHEMA = `
{
  "agentRole": "string",
  "sentiment": "POSITIVE|CAUTIOUS|CONCERNED|CRITICAL",
  "topFindings": ["string (max 3, each references a specific number)"],
  "recommendations": [
    {
      "action": "string",
      "priority": "HIGH|MEDIUM|LOW",
      "effort": "LOW|MEDIUM|HIGH",
      "timeframe": "THIS_WEEK|THIS_MONTH|THIS_QUARTER",
      "expectedImpact": "string"
    }
  ],
  "risks": ["string (max 3)"],
  "opportunities": ["string (max 3)"],
  "debatePoints": ["string (max 2, points to raise with other advisors)"]
}
`.trim()

// ── Agent system prompts ────────────────────────────────────────────────────────
const AGENTS = [
  {
    role: 'CEO_ADVISOR',
    system: `${BASE_RULES}

You are the CEO Advisor. Focus: long-term growth strategy, market positioning, business model health.

Analyse the data and address:
- Is the business growing or contracting? At what rate?
- Which products or segments have the most growth potential?
- Is the current business model (e.g. ambassador reseller) working?
- What is the single most important strategic move right now?
- Are there strategic risks in the next quarter?

Think in 30/90/180 day horizons. Max 3 recommendations.

Output JSON matching this schema exactly:
${OUTPUT_SCHEMA}`,
  },
  {
    role: 'CFO_ADVISOR',
    system: `${BASE_RULES}

You are the CFO Advisor. Focus: profitability, cash flow, cost control, financial sustainability.

Analyse the data and address:
- Is the business profitable? What is the profit margin?
- Is cash flow healthy or are there warning signs?
- Which expenses are disproportionately large?
- Is revenue growing faster or slower than expenses?
- What pricing or cost changes would most improve profitability?

Prioritise cash preservation when margins are below 15%. Max 3 recommendations.

Output JSON matching this schema exactly:
${OUTPUT_SCHEMA}`,
  },
  {
    role: 'MARKETING_ADVISOR',
    system: `${BASE_RULES}

You are the Marketing Advisor. Focus: sales growth, customer acquisition, demand signals, promotions.

Analyse the data and address:
- Which products are underperforming relative to their potential?
- Are there demand signals (events, seasonality) to capitalise on?
- Is customer retention healthy? What does the repeat purchase rate say?
- What is the most cost-effective way to grow revenue this month?
- Is the ambassador/reseller channel performing well?

All marketing ideas must be low-cost or zero-cost (WhatsApp, social, word-of-mouth).
Focus on existing customers before new acquisition. Max 3 recommendations.

Output JSON matching this schema exactly:
${OUTPUT_SCHEMA}`,
  },
  {
    role: 'OPERATIONS_ADVISOR',
    system: `${BASE_RULES}

You are the Operations Advisor. Focus: production efficiency, supply chain, inventory, waste.

Analyse the data and address:
- Is production capacity aligned with demand? Are there bottlenecks?
- Are there stock-outs or overstocking situations?
- Is the waste rate acceptable?
- Are ingredient costs optimised? Are purchase order frequencies efficient?
- What operational change would have the biggest impact on profitability?

Preventing stock-outs of top-selling products is priority one.
Recommendations must be executable by a small team (1-5 people). Max 3 recommendations.

Output JSON matching this schema exactly:
${OUTPUT_SCHEMA}`,
  },
  {
    role: 'RISK_ADVISOR',
    system: `${BASE_RULES}

You are the Risk Advisor. Focus: threats to business continuity, profitability, and reputation.

Identify risks across:
- Financial: cash shortfalls, unprofitable products, rising costs
- Operational: supply chain failures, stock-outs, production bottlenecks
- Market: customer churn, demand drops
- Concentration: over-reliance on one product, customer, or channel
- Food business compliance and reputational risks

Be specific — cite the data signal behind each risk.
Provide a mitigation for each. Max 3 recommendations.

Output JSON matching this schema exactly:
${OUTPUT_SCHEMA}`,
  },
  {
    role: 'CUSTOMER_ADVISOR',
    system: `${BASE_RULES}

You are the Customer Advisor. You represent the customer's perspective.

Analyse the data and address:
- Are customers satisfied based on behavioural signals (repeat rate, order frequency)?
- Are there patterns in when customers buy that suggest unmet demand?
- Which products are customers choosing most and least?
- What would customers want the business to do differently?

Use behavioural data as proxies for sentiment.
Balance customer preference with business sustainability. Max 3 recommendations.

Output JSON matching this schema exactly:
${OUTPUT_SCHEMA}`,
  },
]

// ── Synthesizer ─────────────────────────────────────────────────────────────────
const SYNTHESIZER_SYSTEM = `${BASE_RULES}

You are the Board Meeting Chair. You have received analyses from 6 specialist advisors.
Synthesise their inputs into a clear, actionable board meeting report.

Rules:
- Amplify consensus points
- Explain tensions where advisors conflict, then give a balanced recommendation
- Rank the top 5 recommended actions by impact × urgency
- Every recommendation must have a clear owner role and timeframe
- The report must be readable in under 5 minutes
- Small business owners need clear verdicts, not corporate jargon

Output ONLY valid JSON matching this schema exactly:
{
  "verdict": {
    "overallHealth": "STRONG|STABLE|AT_RISK|CRITICAL",
    "headline": "string (one sentence summary of business health)",
    "boardSentiment": { "positive": 0, "cautious": 0, "concerned": 0, "critical": 0 }
  },
  "keyInsights": [
    { "insight": "string", "source": "AGENT_ROLE", "dataRef": "string (the specific metric)" }
  ],
  "recommendedActions": [
    {
      "action": "string",
      "owner": "string (CEO/CFO/Operations/Marketing)",
      "priority": "HIGH|MEDIUM|LOW",
      "timeframe": "THIS_WEEK|THIS_MONTH|THIS_QUARTER",
      "expectedImpact": "string",
      "advisorConsensus": "agreed|mixed|single-advisor"
    }
  ],
  "riskWarnings": [
    { "risk": "string", "severity": "CRITICAL|HIGH|MEDIUM|LOW", "mitigation": "string" }
  ],
  "growthOpportunities": [
    { "opportunity": "string", "potentialValue": "string", "effort": "LOW|MEDIUM|HIGH", "timeframe": "string" }
  ],
  "advisorHighlights": [
    { "role": "string", "headline": "string", "sentiment": "string" }
  ],
  "nextMeetingFocus": ["string (3 things to review next meeting)"]
}`

// ── Main orchestrator ───────────────────────────────────────────────────────────
export interface BoardMeetingOptions {
  includeDebate?: boolean
}

export interface AgentAnalysis {
  agentRole: string
  sentiment: string
  topFindings: string[]
  recommendations: { action: string; priority: string; effort: string; timeframe: string; expectedImpact: string }[]
  risks: string[]
  opportunities: string[]
  debatePoints: string[]
}

export interface BoardMeetingReport {
  meta: {
    generatedAt: string
    periodDays: number
    debateEnabled: boolean
    agentModel: string
    synthModel: string
    totalAgentCalls: number
  }
  verdict: {
    overallHealth: string
    headline: string
    boardSentiment: { positive: number; cautious: number; concerned: number; critical: number }
  }
  keyInsights: { insight: string; source: string; dataRef: string }[]
  recommendedActions: { action: string; owner: string; priority: string; timeframe: string; expectedImpact: string; advisorConsensus: string }[]
  riskWarnings: { risk: string; severity: string; mitigation: string }[]
  growthOpportunities: { opportunity: string; potentialValue: string; effort: string; timeframe: string }[]
  advisorHighlights: { role: string; headline: string; sentiment: string }[]
  nextMeetingFocus: string[]
  agentAnalyses: { role: string; analysis: AgentAnalysis }[]
}

function parseJson(text: string, label = ''): any {
  const clean = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()

  // Try 1: direct parse of cleaned text
  try { return JSON.parse(clean) } catch {}

  // Try 2: scan every { position — handles prose/garbage before the JSON object
  let pos = 0
  while (true) {
    const start = clean.indexOf('{', pos)
    if (start === -1) break
    // Try closing from the last } backwards (handles truncated outer wrapper)
    let end = clean.lastIndexOf('}')
    while (end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)) } catch {}
      end = clean.lastIndexOf('}', end - 1)
    }
    pos = start + 1
  }

  // All attempts failed
  console.error(`[board] parseJson failed${label ? ` (${label})` : ''}. Raw text (500 chars):\n${text.slice(0, 500)}`)
  return {}
}

/** Compact the snapshot to reduce token usage — keep numbers, trim verbose arrays */
function compactSnapshot(s: BusinessSnapshot): object {
  return {
    business: s.business,
    sales: {
      totalRevenue:         s.sales.totalRevenue,
      totalOrders:          s.sales.totalOrders,
      avgOrderValue:        s.sales.avgOrderValue,
      revenueVsPriorPeriod: s.sales.revenueVsPriorPeriod,
      topProducts:          s.sales.topProducts.slice(0, 5).map(p => ({ name: p.name, revenue: p.revenue, units: p.units })),
      slowestProducts:      s.sales.slowestProducts.slice(0, 3).map(p => ({ name: p.name, revenue: p.revenue, units: p.units })),
      revenueByWeekday:     s.sales.revenueByWeekday,
    },
    finance: {
      totalIncome:              s.finance.totalIncome,
      totalExpenses:            s.finance.totalExpenses,
      netProfit:                s.finance.netProfit,
      profitMargin:             s.finance.profitMargin,
      largestExpenseCategories: s.finance.largestExpenseCategories.slice(0, 5),
      cashPosition:             s.finance.cashPosition,
      outstandingReceivables:   s.finance.outstandingReceivables,
    },
    inventory: {
      totalStockValue:   s.inventory.totalStockValue,
      lowStockCount:     s.inventory.lowStockItems.length,
      lowStockItems:     s.inventory.lowStockItems.slice(0, 5).map(i => `${i.name} (${i.currentStock}/${i.minStock})`),
      outOfStockCount:   s.inventory.outOfStockItems.length,
      outOfStockItems:   s.inventory.outOfStockItems.slice(0, 5),
      stockTurnoverRate: s.inventory.stockTurnoverRate,
    },
    production: s.production,
    customers:  s.customers,
    signals:    s.signals,
  }
}

export async function runBoardMeeting(
  snapshot: BusinessSnapshot,
  opts: BoardMeetingOptions = {}
): Promise<BoardMeetingReport> {
  const dataBlock = JSON.stringify(compactSnapshot(snapshot))

  const phase1Prompt = `Business data snapshot (currency: ZAR, symbol R):\n${dataBlock}\n\nRespond with JSON only — no prose, no markdown.`

  // ── Phase 1: Parallel agent analysis ────────────────────────────────────────
  const phase1Results = await Promise.all(
    AGENTS.map(async agent => {
      const r = await client.messages.create({
        model:      AGENT_MODEL,
        max_tokens: 1500,
        system:     agent.system,
        messages:   [{ role: 'user', content: phase1Prompt }],
      })
      const rawText = r.content[0]?.type === 'text' ? r.content[0].text : ''
      console.log(`[board] ${agent.role} stop_reason=${r.stop_reason} tokens=${r.usage?.output_tokens} raw(300)=${rawText.slice(0, 300)}`)
      const analysis = parseJson(rawText || '{}', agent.role) as AgentAnalysis
      return { role: agent.role, analysis }
    })
  )

  // ── Phase 2: Debate (optional) ───────────────────────────────────────────────
  let finalResults = phase1Results

  if (opts.includeDebate) {
    const phase1Summary = phase1Results.map(r =>
      `${r.role}: Findings — ${(r.analysis.topFindings || []).join(' | ')} | Debate points — ${(r.analysis.debatePoints || []).join(' | ')}`
    ).join('\n')

    const debatePrompt = `
Other advisors' Phase 1 findings:
${phase1Summary}

Now refine your analysis. You may agree and amplify, or challenge with data.
Output the same JSON schema with your refined positions.`.trim()

    finalResults = await Promise.all(
      AGENTS.map((agent, i) =>
        client.messages.create({
          model:      AGENT_MODEL,
          max_tokens: 1200,
          system:     agent.system,
          messages:   [
            { role: 'user',      content: phase1Prompt },
            { role: 'assistant', content: JSON.stringify(phase1Results[i].analysis) },
            { role: 'user',      content: debatePrompt },
          ],
        }).then(r => ({
          role:     agent.role,
          analysis: parseJson(r.content[0].type === 'text' ? r.content[0].text : '{}', agent.role) as AgentAnalysis,
        }))
      )
    )
  }

  // ── Phase 3: Synthesis ───────────────────────────────────────────────────────
  const allAnalyses = JSON.stringify(finalResults)

  const synthResponse = await client.messages.create({
    model:      SYNTH_MODEL,
    max_tokens: 8000,
    system:     SYNTHESIZER_SYSTEM,
    messages:   [{
      role:    'user',
      content: `Business: ${snapshot.business.name} | Period: ${snapshot.business.periodDays} days\n\nAdvisor analyses:\n${allAnalyses}\n\nProduce the final board meeting report JSON. Be concise — max 3 items per array, strings under 120 chars each.`,
    }],
  })

  const synthRaw  = synthResponse.content[0].type === 'text' ? synthResponse.content[0].text : '{}'
  console.log(`[board] SYNTHESISER stop_reason=${synthResponse.stop_reason} tokens=${synthResponse.usage?.output_tokens}`)
  const synthJson = parseJson(synthRaw, 'SYNTHESISER')

  const totalCalls = opts.includeDebate ? AGENTS.length * 2 + 1 : AGENTS.length + 1

  return {
    meta: {
      generatedAt:     new Date().toISOString(),
      periodDays:      snapshot.business.periodDays,
      debateEnabled:   opts.includeDebate ?? false,
      agentModel:      AGENT_MODEL,
      synthModel:      SYNTH_MODEL,
      totalAgentCalls: totalCalls,
    },
    verdict:             synthJson.verdict             || {},
    keyInsights:         synthJson.keyInsights         || [],
    recommendedActions:  synthJson.recommendedActions  || [],
    riskWarnings:        synthJson.riskWarnings        || [],
    growthOpportunities: synthJson.growthOpportunities || [],
    advisorHighlights:   synthJson.advisorHighlights   || [],
    nextMeetingFocus:    synthJson.nextMeetingFocus    || [],
    agentAnalyses:       finalResults,
  }
}
