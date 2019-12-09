#!/usr/bin/env node
'use strict';

const args = require('yargs').argv;
const utils = require('barrkeep/utils');
const Indexer = require('./indexer');

//////////

const config = {};

if (args.config) {
  utils.merge(config, require(args.config));
}

if (args.cwd) {
  config.cwd = args.cwd;
}
if (args.dir) {
  config.cwd = args.dir;
}

if (args.pattern) {
  config.pattern = args.pattern;
}

//////////

const indexer = new Indexer(config);
indexer.scan();
