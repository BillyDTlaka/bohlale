import { FastifyInstance } from 'fastify'
import { requireApiKey } from '../../shared/middleware/api-key'
import { AppError } from '../../shared/errors'
import { generateStrategy, refineStrategy, saveStrategyContent } from './strategy.service'

export default async function strategyRoutes(fastify: FastifyInstance) {
  const db   = fastify.prisma as any
  const auth = [requireApiKey]

  // ── POST /strategy ── Create + async generation
  fastify.post('/', { preHandler: auth }, async (req: any, reply) => {
    const { title, context } = req.body as { title?: string; context?: any }

    const strategy = await db.strategy.create({
      data: {
        projectId:   req.project.id,
        title:       title || `${req.project.name} Business Strategy ${new Date().getFullYear()}`,
        status:      'GENERATING',
        contextJson: context || {},
      },
    })

    setImmediate(async () => { await generateStrategy(db, strategy.id) })

    return reply.code(202).send({ id: strategy.id, status: 'GENERATING' })
  })

  // ── GET /strategy ── List
  fastify.get('/', { preHandler: auth }, async (req: any) => {
    return db.strategy.findMany({
      where:   { projectId: req.project.id },
      select:  { id: true, title: true, status: true, currentVersion: true, errorMessage: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
      take:    30,
    })
  })

  // ── GET /strategy/:id
  fastify.get('/:id', { preHandler: auth }, async (req: any, reply) => {
    const s = await db.strategy.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!s) throw new AppError('Strategy not found', 404, 'NOT_FOUND')
    return s
  })

  // ── PATCH /strategy/:id/content ── Manual edit
  fastify.patch('/:id/content', { preHandler: auth }, async (req: any) => {
    const body = req.body as any
    return saveStrategyContent(db, req.params.id, body, body.changeNote)
  })

  // ── PATCH /strategy/:id/title
  fastify.patch('/:id/title', { preHandler: auth }, async (req: any) => {
    const { title } = req.body as { title: string }
    if (!title?.trim()) throw new AppError('Title is required', 400, 'INVALID_BODY')
    return db.strategy.updateMany({
      where: { id: req.params.id, projectId: req.project.id },
      data:  { title: title.trim() },
    })
  })

  // ── POST /strategy/:id/refine ── AI refinement
  fastify.post('/:id/refine', { preHandler: auth }, async (req: any, reply) => {
    const s = await db.strategy.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!s) throw new AppError('Strategy not found', 404, 'NOT_FOUND')
    const { instructions } = req.body as { instructions: string }
    if (!instructions?.trim()) throw new AppError('instructions is required', 400, 'INVALID_BODY')

    await db.strategy.update({ where: { id: s.id }, data: { status: 'GENERATING' } })
    setImmediate(async () => { await refineStrategy(db, s.id, instructions.trim()) })

    return reply.code(202).send({ id: s.id, status: 'GENERATING' })
  })

  // ── GET /strategy/:id/versions
  fastify.get('/:id/versions', { preHandler: auth }, async (req: any) => {
    return db.strategyVersion.findMany({
      where:   { strategyId: req.params.id },
      orderBy: { version: 'desc' },
    })
  })

  // ── DELETE /strategy/:id
  fastify.delete('/:id', { preHandler: auth }, async (req: any, reply) => {
    await db.strategy.deleteMany({ where: { id: req.params.id, projectId: req.project.id } })
    return reply.code(204).send()
  })
}
