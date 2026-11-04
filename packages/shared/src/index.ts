/** Project name shared by every workspace package. Placeholder until AGO-61+ add real schemas. */
export const PROJECT_NAME = "Agent Office";

export function describeWorkspace(packageName: string): string {
  return `${packageName} (${PROJECT_NAME})`;
}
