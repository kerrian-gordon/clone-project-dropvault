const inlineMimeTypes = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg',
  'video/mp4', 'video/webm',
]);

export function contentHeaders(file, download) {
  const inline = !download && inlineMimeTypes.has(file.mimeType);
  const encodedName = encodeURIComponent(file.name).replace(/['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'Content-Type': inline ? file.mimeType : 'application/octet-stream',
    'Content-Length': file.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}
