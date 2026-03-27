export const config = {
  port:        Number(process.env.PORT) || 4000,
  isDev:       process.env.NODE_ENV !== 'production',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  adminSecret: process.env.ADMIN_SECRET || 'dev-admin-secret',
}
