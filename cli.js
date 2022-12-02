#!/usr/bin/env node
'use strict';

const args = require('yargs').argv;
const Indexer = require('./indexer');

//////////

const config = {};

if (args.config) {
  Object.assign(config, require(args.config));
} else {
  Object.assign(config, args);
}

//////////

async function main () {
  try {
    const indexer = new Indexer(config);
    await indexer.start();
    await indexer.scan();
    await indexer.stop();
  } catch (error) {
    console.log('[error]', error);
  }
}

main();
