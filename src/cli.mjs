import { runCli } from './cli-runner.mjs';

const exitCode = await runCli();
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
