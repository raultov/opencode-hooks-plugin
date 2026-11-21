#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { runCli } from "./cli.js";

const confirm = async (question: string): Promise<boolean> => {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
};

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  confirm: stdin.isTTY ? confirm : undefined,
});
