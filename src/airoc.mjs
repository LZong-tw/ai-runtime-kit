#!/usr/bin/env node

import { runExternalClientCli } from "./airkit.mjs";

runExternalClientCli("opencode")
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`airoc: ${error.message}`);
    process.exitCode = 1;
  });
