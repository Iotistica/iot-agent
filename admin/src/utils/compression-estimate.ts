export interface CompressionEstimate {
  originalSize: number
  compressedSize: number
  savedBytes: number
  savedPercent: number
}

/**
 * Estimates what the 'json+deflate' subscription compression option (see
 * src/publish/core/compress.ts's SubscriptionCompression type on the
 * backend) would achieve for this exact payload, using the browser's native
 * Compression Streams API. 'deflate' here — not 'gzip' or 'deflate-raw' —
 * is a deliberate match to Node's zlib.deflate() used server-side: same
 * DEFLATE algorithm, same zlib header/trailer framing, so this is a genuine
 * apples-to-apples prediction rather than a rough approximation from a
 * different compressor. Returns null when the API is unsupported (older
 * browsers) or the input is empty.
 */
export async function estimateDeflateRatio(text: string): Promise<CompressionEstimate | null> {
  if (!text) return null
  if (typeof CompressionStream === 'undefined') return null

  const originalBytes = new TextEncoder().encode(text)
  const stream = new Blob([originalBytes]).stream().pipeThrough(new CompressionStream('deflate'))
  const compressedBuffer = await new Response(stream).arrayBuffer()

  const originalSize = originalBytes.length
  const compressedSize = compressedBuffer.byteLength
  const savedBytes = originalSize - compressedSize

  return {
    originalSize,
    compressedSize,
    savedBytes,
    savedPercent: originalSize > 0 ? Math.round((savedBytes / originalSize) * 1000) / 10 : 0,
  }
}
