export class RequestBodyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Count wire bytes, then decode once so split UTF-8 characters stay intact.
export async function readBody(req, maxBytes = 2_000_000) {
  let size = 0;
  let oversized = false;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      oversized = true;
      chunks.length = 0;
    }
    if (!oversized) chunks.push(Buffer.from(chunk));
  }
  if (oversized) throw new RequestBodyError('Request is too large.', 413);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new RequestBodyError('Request must be valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestBodyError('Request must be a JSON object.');
  }
  return body;
}
