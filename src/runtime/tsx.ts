export function buildTsxCommand(scriptPath: string, args: string[] = []): string[] {
  return ["npx", "tsx", scriptPath, ...args];
}
