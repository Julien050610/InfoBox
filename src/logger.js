function write(level, operation, context = {}) {
  const record = { time: new Date().toISOString(), level, operation };
  for (const key of ['materialId', 'jobId', 'errorCode', 'method', 'route']) {
    if (context[key] !== undefined && context[key] !== null) record[key] = context[key];
  }
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (operation, context) => write('info', operation, context),
  warn: (operation, context) => write('warn', operation, context),
  error: (operation, context) => write('error', operation, context),
};
