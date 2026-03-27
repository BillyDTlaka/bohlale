export class AppError extends Error {
  statusCode: number
  code: string
  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export class NotFoundError extends AppError {
  constructor(msg = 'Not found') { super(msg, 404, 'NOT_FOUND') }
}

export class UnauthorizedError extends AppError {
  constructor(msg = 'Unauthorized') { super(msg, 401, 'UNAUTHORIZED') }
}

export class ForbiddenError extends AppError {
  constructor(msg = 'Forbidden') { super(msg, 403, 'FORBIDDEN') }
}
