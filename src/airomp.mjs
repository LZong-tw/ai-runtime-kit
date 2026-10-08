#!/usr/bin/env node

import { runExternalClientCli } from "./airkit.mjs";

runExternalClientCli("omp")
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`airomp: ${error.message}`);
    process.exitCode = 1;
  });
