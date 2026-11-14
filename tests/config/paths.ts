import path from "node:path";

export const repositoryRoot = path.resolve(__dirname, "../..");
export const browserTests = path.join(repositoryRoot, "tests/browser");
export const testResults = (suite: string) => path.join(repositoryRoot, "test-results", suite);
