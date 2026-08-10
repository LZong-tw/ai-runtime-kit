#!/usr/bin/env node

import { runExternalClientCli } from "./airkit.mjs";

runExternalClientCli("pi")
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`airpi: ${error.message}`);
    process.exitCode = 1;
  });
