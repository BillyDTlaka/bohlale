import { FastifyInstance } from 'fastify'
import { requireApiKey } from '../../shared/middleware/api-key'
import { TOOL_REGISTRY, getEnabledTools, runAgent } from './agents.service'

export default async function agentRoutes(fastify: FastifyInstance) {
  const db = fastify.prisma as any
  const auth = [requireApiKey]

  // ── GET /agents/tools ── List available tools
  fastify.get('/tools', { preHandler: auth }, async () => {
    return TOOL_REGISTRY.map(t => ({
      name:        t.name,
      label:       t.label,
      description: t.description,
    }))
  })

  // ── GET /agents ── List this project's agents
  fastify.get('/', { preHandler: auth }, async (req: any) => {
    return db.agent.findMany({
      where:   { projectId: req.project.id },
      orderBy: { createdAt: 'desc' },
    })
  })

  // ── POST /agents ── Create agent
  fastify.post('/', { preHandler: auth }, async (req: any, reply) => {
    const { name, slug, description, systemPrompt, model, maxTokens, enabledTools } = req.body as any
    if (!name?.trim())         return reply.code(400).send({ message: 'name is required' })
    if (!slug?.trim())         return reply.code(400).send({ message: 'slug is required' })
    if (!systemPrompt?.trim()) return reply.code(400).send({ message: 'systemPrompt is required' })

    const agent = await db.agent.create({
      data: {
        projectId:    req.project.id,
        name:         name.trim(),
        slug:         slug.trim().toLowerCase().replace(/\s+/g, '-'),
        description:  description?.trim(),
        systemPrompt: systemPrompt.trim(),
        model:        model        || 'claude-sonnet-4-6',
        maxTokens:    maxTokens    || 4096,
        enabledTools: enabledTools || [],
      },
    })
    return reply.code(201).send(agent)
  })

  // ── GET /agents/:id ── Single agent
  fastify.get('/:id', { preHandler: auth }, async (req: any, reply) => {
    const agent = await db.agent.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!agent) return reply.code(404).send({ message: 'Agent not found' })
    return agent
  })

  // ── PATCH /agents/:id ── Update config
  fastify.patch('/:id', { preHandler: auth }, async (req: any, reply) => {
    const { id } = req.params
    const existing = await db.agent.findFirst({ where: { id, projectId: req.project.id } })
    if (!existing) return reply.code(404).send({ message: 'Agent not found' })

    const { name, slug, description, systemPrompt, model, maxTokens, enabledTools, isActive } = req.body as any
    const data: any = {}
    if (name         !== undefined) data.name         = name.trim()
    if (slug         !== undefined) data.slug         = slug.trim().toLowerCase().replace(/\s+/g, '-')
    if (description  !== undefined) data.description  = description
    if (systemPrompt !== undefined) data.systemPrompt = systemPrompt.trim()
    if (model        !== undefined) data.model        = model
    if (maxTokens    !== undefined) data.maxTokens    = Number(maxTokens)
    if (enabledTools !== undefined) data.enabledTools = enabledTools
    if (isActive     !== undefined) data.isActive     = isActive

    return db.agent.update({ where: { id }, data })
  })

  // ── DELETE /agents/:id
  fastify.delete('/:id', { preHandler: auth }, async (req: any, reply) => {
    const existing = await db.agent.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!existing) return reply.code(404).send({ message: 'Agent not found' })
    await db.agent.delete({ where: { id: req.params.id } })
    return reply.code(204).send()
  })

  // ── POST /agents/:id/chat ── Stateless single-turn chat
  fastify.post('/:id/chat', { preHandler: auth }, async (req: any, reply) => {
    const agent = await db.agent.findFirst({
      where: { id: req.params.id, projectId: req.project.id, isActive: true },
    })
    if (!agent) return reply.code(404).send({ message: 'Agent not found or inactive' })

    const { message } = req.body as any
    if (!message?.trim()) return reply.code(400).send({ message: 'message is required' })

    const tools = getEnabledTools(agent.enabledTools as string[])
    const reply_text = await runAgent({
      systemPrompt: agent.systemPrompt,
      model:        agent.model,
      maxTokens:    agent.maxTokens,
      tools,
      messages:     [{ role: 'user', content: message.trim() }],
      ctx:          { db, projectId: req.project.id },
    })

    return { reply: reply_text }
  })

  // ── POST /agents/:id/conversations ── Create a conversation
  fastify.post('/:id/conversations', { preHandler: auth }, async (req: any, reply) => {
    const agent = await db.agent.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!agent) return reply.code(404).send({ message: 'Agent not found' })

    const conv = await db.agentConversation.create({
      data: { agentId: agent.id, projectId: req.project.id, messages: [] },
    })
    return reply.code(201).send(conv)
  })

  // ── GET /agents/:id/conversations ── List conversations
  fastify.get('/:id/conversations', { preHandler: auth }, async (req: any) => {
    return db.agentConversation.findMany({
      where:   { agentId: req.params.id, projectId: req.project.id },
      select:  { id: true, title: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take:    50,
    })
  })

  // ── POST /agents/:id/conversations/:convId/messages ── Multi-turn message
  fastify.post('/:id/conversations/:convId/messages', { preHandler: auth }, async (req: any, reply) => {
    const agent = await db.agent.findFirst({
      where: { id: req.params.id, projectId: req.project.id, isActive: true },
    })
    if (!agent) return reply.code(404).send({ message: 'Agent not found or inactive' })

    const conv = await db.agentConversation.findFirst({
      where: { id: req.params.convId, projectId: req.project.id },
    })
    if (!conv) return reply.code(404).send({ message: 'Conversation not found' })

    const { message } = req.body as any
    if (!message?.trim()) return reply.code(400).send({ message: 'message is required' })

    const history = (conv.messages as any[]) || []
    history.push({ role: 'user', content: message.trim() })

    const tools = getEnabledTools(agent.enabledTools as string[])
    const reply_text = await runAgent({
      systemPrompt: agent.systemPrompt,
      model:        agent.model,
      maxTokens:    agent.maxTokens,
      tools,
      messages:     history,
      ctx:          { db, projectId: req.project.id },
    })

    history.push({ role: 'assistant', content: reply_text })

    // Auto-title from first user message
    const title = conv.title === 'New Conversation'
      ? message.trim().slice(0, 60) + (message.length > 60 ? '…' : '')
      : conv.title

    await db.agentConversation.update({
      where: { id: conv.id },
      data:  { messages: history, title, updatedAt: new Date() },
    })

    return { reply: reply_text, conversationId: conv.id }
  })

  // ── DELETE /agents/:id/conversations/:convId
  fastify.delete('/:id/conversations/:convId', { preHandler: auth }, async (req: any, reply) => {
    await db.agentConversation.deleteMany({
      where: { id: req.params.convId, projectId: req.project.id },
    })
    return reply.code(204).send()
  })
}
