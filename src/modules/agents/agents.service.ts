import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })

// ── Tool registry ─────────────────────────────────────────────────────────────
// Tools are pre-built here for safety. Projects enable/disable them per agent.
// Each tool receives (input, context) where context = { db, project, dataSource? }

export interface ToolDef {
  name:        string
  label:       string
  description: string // shown in UI
  schema: {
    name:         string
    description:  string
    input_schema: object
  }
  execute: (input: any, ctx: ToolContext) => Promise<any>
}

export interface ToolContext {
  db:        any
  projectId: string
  dataSource?: any
}

export const TOOL_REGISTRY: ToolDef[] = [
  {
    name:  'query_data_source',
    label: 'Query Data Source',
    description: 'Run a read-only SQL query against a registered PostgreSQL data source',
    schema: {
      name:        'query_data_source',
      description: 'Run a read-only SQL SELECT query against a connected data source. Use this to look up real business data.',
      input_schema: {
        type: 'object',
        properties: {
          dataSourceId: { type: 'string', description: 'ID of the data source to query' },
          sql:          { type: 'string', description: 'SELECT query to run (read-only)' },
        },
        required: ['dataSourceId', 'sql'],
      },
    },
    execute: async (input, ctx) => {
      // Validate it's a SELECT query
      const sql = (input.sql as string).trim()
      if (!/^SELECT\s/i.test(sql)) throw new Error('Only SELECT queries are allowed')

      const ds = await ctx.db.dataSource.findFirst({
        where: { id: input.dataSourceId, projectId: ctx.projectId, isActive: true },
      })
      if (!ds) throw new Error('Data source not found')
      if (ds.type !== 'postgres') throw new Error('Only postgres data sources support SQL queries')

      const { Client } = require('pg')
      const pgClient = new Client({ connectionString: ds.config.connectionString })
      await pgClient.connect()
      try {
        const result = await pgClient.query(sql)
        return { rows: result.rows.slice(0, 100), rowCount: result.rowCount }
      } finally {
        await pgClient.end()
      }
    },
  },
  {
    name:  'list_data_sources',
    label: 'List Data Sources',
    description: 'List the data sources registered for this project',
    schema: {
      name:        'list_data_sources',
      description: 'List all active data sources connected to this project',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async (_input, ctx) => {
      const sources = await ctx.db.dataSource.findMany({
        where: { projectId: ctx.projectId, isActive: true },
        select: { id: true, name: true, type: true, lastSyncAt: true },
      })
      return sources
    },
  },
  {
    name:  'get_knowledge_documents',
    label: 'Knowledge Documents',
    description: 'Search the project knowledge base documents',
    schema: {
      name:        'get_knowledge_documents',
      description: 'Retrieve knowledge documents from the project knowledge base. Use this for company policies, procedures, or reference data.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional keyword to filter documents by name' },
        },
      },
    },
    execute: async (input, ctx) => {
      const where: any = { projectId: ctx.projectId }
      if (input.search) where.name = { contains: input.search, mode: 'insensitive' }
      const docs = await ctx.db.knowledgeDocument.findMany({
        where,
        select: { id: true, name: true, description: true, content: true, fileType: true },
        take: 10,
      })
      return docs
    },
  },
  {
    name:  'get_current_date',
    label: 'Current Date',
    description: 'Get the current date and time',
    schema: {
      name:        'get_current_date',
      description: 'Get the current date and time in ISO format',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ now: new Date().toISOString(), date: new Date().toDateString() }),
  },
]

export function getEnabledTools(enabledToolNames: string[]): ToolDef[] {
  return TOOL_REGISTRY.filter(t => enabledToolNames.includes(t.name))
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export interface RunAgentOptions {
  systemPrompt:  string
  model:         string
  maxTokens:     number
  tools:         ToolDef[]
  messages:      { role: 'user' | 'assistant'; content: any }[]
  ctx:           ToolContext
}

export async function runAgent(opts: RunAgentOptions): Promise<string> {
  const { systemPrompt, model, maxTokens, tools, ctx } = opts
  const messages = [...opts.messages]

  const toolSchemas = tools.map(t => t.schema)

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      tools:      toolSchemas as any,
      messages,
    })

    if (response.stop_reason === 'end_turn') {
      return response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: any[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const toolDef = tools.find(t => t.name === block.name)
        let result: any
        try {
          result = toolDef
            ? await toolDef.execute((block as any).input, ctx)
            : { error: `Tool "${block.name}" is not available` }
        } catch (e: any) {
          result = { error: e.message }
        }
        toolResults.push({
          type:        'tool_result',
          tool_use_id: (block as any).id,
          content:     JSON.stringify(result),
        })
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    // Unexpected stop reason
    break
  }

  return ''
}
