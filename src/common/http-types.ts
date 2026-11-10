export interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export interface HttpRequestLike {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}
