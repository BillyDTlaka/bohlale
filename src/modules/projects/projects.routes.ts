import { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { config } from '../../config'

export default async function projectRoutes(fastify: FastifyInstance) {
  const db = fastify.prisma as any

  // Admin-only guard: requires ADMIN_SECRET header
  const adminOnly = async (req: any, reply: any) => {
    if (req.headers['x-admin-secret'] !== config.adminSecret) {
      return reply.code(401).send({ message: 'Invalid admin secret' })
    }
  }

  // ── POST /projects ── Register a new project, get back an API key
  fastify.post('/', { preHandler: adminOnly }, async (req, reply) => {
    const { name } = req.body as { name: string }
    if (!name?.trim()) return reply.code(400).send({ message: 'name is required' })

    const apiKey = 'bhl_' + randomBytes(24).toString('hex')
    const project = await db.project.create({
      data: { name: name.trim(), apiKey },
    })

    return reply.code(201).send({
      id:     project.id,
      name:   project.name,
      apiKey: project.apiKey,
      note:   'Store this API key — it will not be shown again.',
    })
  })

  // ── GET /projects ── List all projects (admin)
  fastify.get('/', { preHandler: adminOnly }, async () => {
    return db.project.findMany({
      select: { id: true, name: true, apiKey: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
  })

  // ── PATCH /projects/:id ── Update name or revoke/restore
  fastify.patch('/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as any
    const { name, isActive } = req.body as any
    const data: any = {}
    if (name     !== undefined) data.name     = name.trim()
    if (isActive !== undefined) data.isActive = isActive
    return db.project.update({ where: { id }, data })
  })

  // ── POST /projects/:id/rotate-key ── Issue a new API key
  fastify.post('/:id/rotate-key', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as any
    const apiKey = 'bhl_' + randomBytes(24).toString('hex')
    await db.project.update({ where: { id }, data: { apiKey } })
    return { apiKey, note: 'Previous key is now invalid.' }
  })

  // ── GET /projects/me ── Called by a project using its API key
  fastify.get('/me', async (req: any, reply) => {
    const key = req.headers['x-bohlale-key'] as string | undefined
    if (!key) return reply.code(401).send({ message: 'Missing X-Bohlale-Key' })
    const project = await db.project.findUnique({
      where: { apiKey: key },
      select: { id: true, name: true, isActive: true, createdAt: true },
    })
    if (!project) return reply.code(401).send({ message: 'Invalid API key' })
    return project
  })
}
