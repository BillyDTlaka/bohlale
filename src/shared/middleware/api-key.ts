import { FastifyRequest, FastifyReply } from 'fastify'
import { UnauthorizedError } from '../errors'

// Attaches the resolved project to every authenticated request
declare module 'fastify' {
  interface FastifyRequest {
    project: { id: string; name: string }
  }
}

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {
  const key = req.headers['x-bohlale-key'] as string | undefined
  if (!key) throw new UnauthorizedError('Missing X-Bohlale-Key header')

  const db = req.server.prisma as any
  const project = await db.project.findUnique({ where: { apiKey: key, isActive: true } })
  if (!project) throw new UnauthorizedError('Invalid or revoked API key')

  req.project = { id: project.id, name: project.name }
}
