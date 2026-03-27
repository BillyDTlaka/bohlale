import { FastifyInstance } from 'fastify'
import { requireApiKey } from '../../shared/middleware/api-key'
import { AppError } from '../../shared/errors'
import { streamChatReply } from './chat.service'

export default async function chatRoutes(fastify: FastifyInstance) {
  const db   = fastify.prisma as any
  const auth = [requireApiKey]

  // ── Conversations ──────────────────────────────────────────────────────────

  fastify.post('/conversations', { preHandler: auth }, async (req: any, reply) => {
    const conv = await db.chatConversation.create({ data: { projectId: req.project.id } })
    return reply.code(201).send(conv)
  })

  fastify.get('/conversations', { preHandler: auth }, async (req: any) => {
    return db.chatConversation.findMany({
      where:   { projectId: req.project.id },
      orderBy: { updatedAt: 'desc' },
      take:    50,
      select:  { id: true, title: true, createdAt: true, updatedAt: true },
    })
  })

  fastify.get('/conversations/:id', { preHandler: auth }, async (req: any, reply) => {
    const conv = await db.chatConversation.findFirst({
      where:   { id: req.params.id, projectId: req.project.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (!conv) throw new AppError('Conversation not found', 404, 'NOT_FOUND')
    return conv
  })

  fastify.patch('/conversations/:id', { preHandler: auth }, async (req: any) => {
    const { title } = req.body as { title: string }
    return db.chatConversation.updateMany({
      where: { id: req.params.id, projectId: req.project.id },
      data:  { title },
    })
  })

  fastify.delete('/conversations/:id', { preHandler: auth }, async (req: any, reply) => {
    await db.chatConversation.deleteMany({ where: { id: req.params.id, projectId: req.project.id } })
    return reply.code(204).send()
  })

  // ── Streaming message ──────────────────────────────────────────────────────

  fastify.post('/conversations/:id/message', { preHandler: auth }, async (req: any, reply) => {
    const { content } = req.body as { content: string }
    if (!content?.trim()) throw new AppError('Message content is required', 400, 'INVALID_BODY')

    const conv = await db.chatConversation.findFirst({
      where: { id: req.params.id, projectId: req.project.id },
    })
    if (!conv) throw new AppError('Conversation not found', 404, 'NOT_FOUND')

    await db.chatMessage.create({ data: { conversationId: conv.id, role: 'user', content: content.trim() } })

    if (conv.title === 'New Chat') {
      const title = content.trim().slice(0, 60) + (content.trim().length > 60 ? '…' : '')
      await db.chatConversation.update({ where: { id: conv.id }, data: { title, updatedAt: new Date() } })
    } else {
      await db.chatConversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } })
    }

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    try {
      const fullText = await streamChatReply(db, conv.id, content.trim(), (chunk) => {
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`)
      })
      await db.chatMessage.create({ data: { conversationId: conv.id, role: 'assistant', content: fullText } })
      res.write('data: [DONE]\n\n')
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ error: err?.message || 'Stream failed' })}\n\n`)
    } finally {
      res.end()
    }
  })

  // ── Knowledge Documents ────────────────────────────────────────────────────

  fastify.get('/documents', { preHandler: auth }, async (req: any) => {
    return db.knowledgeDocument.findMany({
      where:   { projectId: req.project.id },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, name: true, description: true, fileType: true, createdAt: true },
    })
  })

  fastify.get('/documents/:id', { preHandler: auth }, async (req: any, reply) => {
    const doc = await db.knowledgeDocument.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!doc) throw new AppError('Document not found', 404, 'NOT_FOUND')
    return doc
  })

  fastify.post('/documents', { preHandler: auth }, async (req: any, reply) => {
    const { name, description, content, fileType } = req.body as any
    if (!name?.trim())    throw new AppError('Name is required', 400, 'INVALID_BODY')
    if (!content?.trim()) throw new AppError('Content is required', 400, 'INVALID_BODY')
    const doc = await db.knowledgeDocument.create({
      data: { projectId: req.project.id, name: name.trim(), description: description?.trim(), content: content.trim(), fileType: fileType || 'text' },
    })
    return reply.code(201).send(doc)
  })

  fastify.patch('/documents/:id', { preHandler: auth }, async (req: any) => {
    const body = req.body as any
    return db.knowledgeDocument.updateMany({
      where: { id: req.params.id, projectId: req.project.id },
      data: {
        ...(body.name        ? { name:        body.name.trim()        } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.content     ? { content:     body.content.trim()     } : {}),
      },
    })
  })

  fastify.delete('/documents/:id', { preHandler: auth }, async (req: any, reply) => {
    await db.knowledgeDocument.deleteMany({ where: { id: req.params.id, projectId: req.project.id } })
    return reply.code(204).send()
  })
}
