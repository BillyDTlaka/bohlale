import { FastifyInstance } from 'fastify'
import { requireApiKey } from '../../shared/middleware/api-key'
import { runBoardMeeting } from './board.service'

export default async function boardRoutes(fastify: FastifyInstance) {
  const db   = fastify.prisma as any
  const auth = [requireApiKey]

  // ── POST /board/run ── Start a meeting (caller provides the business snapshot)
  fastify.post('/run', { preHandler: auth }, async (req: any, reply) => {
    const { snapshot, periodDays = 30, includeDebate = false } = req.body as any
    if (!snapshot) return reply.code(400).send({ message: 'snapshot is required. Build it in your project and send it here.' })

    const meeting = await db.boardMeeting.create({
      data: {
        projectId:    req.project.id,
        periodDays:   Number(periodDays),
        debateEnabled: Boolean(includeDebate),
        status:       'RUNNING',
        snapshotJson: snapshot,
      },
    })

    setImmediate(async () => {
      try {
        const report = await runBoardMeeting(snapshot, { includeDebate: Boolean(includeDebate) })
        await db.boardMeeting.update({
          where: { id: meeting.id },
          data:  { status: 'COMPLETED', reportJson: report as any },
        })
      } catch (err: any) {
        const message = err?.error?.message || err?.message || 'Unknown error'
        await db.boardMeeting.update({
          where: { id: meeting.id },
          data:  { status: 'FAILED', errorMessage: message },
        }).catch(() => {})
      }
    })

    return reply.code(202).send({ id: meeting.id, status: 'RUNNING' })
  })

  // ── GET /board/meetings ── List meetings for this project
  fastify.get('/meetings', { preHandler: auth }, async (req: any) => {
    return db.boardMeeting.findMany({
      where:   { projectId: req.project.id },
      select:  { id: true, periodDays: true, debateEnabled: true, status: true, errorMessage: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take:    30,
    })
  })

  // ── GET /board/meetings/:id ── Poll for result
  fastify.get('/meetings/:id', { preHandler: auth }, async (req: any, reply) => {
    const meeting = await db.boardMeeting.findFirst({
      where: { id: req.params.id, projectId: req.project.id },
    })
    if (!meeting) return reply.code(404).send({ message: 'Board meeting not found' })
    return meeting
  })

  // ── DELETE /board/meetings/:id
  fastify.delete('/meetings/:id', { preHandler: auth }, async (req: any, reply) => {
    await db.boardMeeting.deleteMany({ where: { id: req.params.id, projectId: req.project.id } })
    return reply.code(204).send()
  })
}
