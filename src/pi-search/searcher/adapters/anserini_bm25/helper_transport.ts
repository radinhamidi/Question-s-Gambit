export interface AnseriniBm25HelperTransport {
  request(
    commandType: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
  dispose?(): void;
}
