export {};

declare global {
  interface Error {
    code?: string;
    status?: number;
    statusCode?: number;
  }
}
