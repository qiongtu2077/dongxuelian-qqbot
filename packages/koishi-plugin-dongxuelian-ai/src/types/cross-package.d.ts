declare module '../../../koishi-plugin-daily-report/lib/html-renderer' {
  export function renderHtmlToImage(html: string, options?: unknown): Promise<Buffer>
}
