export class AppError extends Error {
  constructor(code, message, { status = 500, cause = null, expose = true } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.expose = expose;
  }
}

export class ValidationError extends AppError {
  constructor(message, code = 'VALIDATION_ERROR') { super(code, message, { status: 400 }); }
}

export class NotFoundError extends AppError {
  constructor(message, code = 'NOT_FOUND') { super(code, message, { status: 404 }); }
}

export class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') { super(code, message, { status: 409 }); }
}

export class ForbiddenError extends AppError {
  constructor(message, code = 'FORBIDDEN') { super(code, message, { status: 403 }); }
}

export class StorageError extends AppError {
  constructor(message, { code = 'STORAGE_ERROR', cause = null, expose = false } = {}) {
    super(code, message, { status: 500, cause, expose });
  }
}

const LEGACY_VALIDATION = /^Only |^Supported |^File |^Upload |^quality_score|^tags |^published_at|^corrected_text|^favorite |^reading_|^last_opened|^Add |^Unsupported |^Item update|^Move or |^Correction |^Folder |^Parent folder|^Invalid note|^Invalid bookmark|^Bookmark name|^Invalid inbox|^Invalid notebook|^Notebook |^Empty notes|^Bound item|^Cannot delete|^Note content|^Saved view|^Relation |^Related item|^Category |^Restructure |^Select at least|^Selected folders|^Target folder|^This move|^This structure/;

export function errorResponse(error) {
  if (error instanceof AppError) {
    return { status: error.status, body: { code: error.code, error: error.expose ? error.message : '本地数据操作失败，请查看日志后重试。' } };
  }
  if (error instanceof SyntaxError) return { status: 400, body: { code: 'INVALID_JSON', error: '请求内容不是有效 JSON' } };
  if (error instanceof TypeError || LEGACY_VALIDATION.test(error?.message || '')) {
    return { status: 400, body: { code: 'VALIDATION_ERROR', error: error.message } };
  }
  return { status: 500, body: { code: 'INTERNAL_ERROR', error: '操作失败，请查看本地日志后重试。' } };
}
