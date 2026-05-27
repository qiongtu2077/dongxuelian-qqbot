declare module 'mammoth' {
  export function extractRawText(options: { path?: string; buffer?: Buffer }): Promise<{ value: string }>
  export function convertToHtml(options: { path?: string; buffer?: Buffer }): Promise<{ value: string }>
}

declare module 'pdf-parse' {
  function parse(buffer: Buffer, options?: unknown): Promise<{ text: string; numpages: number; info: unknown }>
  export = parse
}

declare module 'silk-wasm' {
  export function encode(pcm: Buffer, sampleRate: number): Promise<Buffer>
  export function decode(silk: Buffer, sampleRate: number): Promise<Buffer>
}
