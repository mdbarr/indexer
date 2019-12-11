#!/usr/bin/env node
'use strict';

const args = require('yargs').argv;
const utils = require('barrkeep/utils');
const Indexer = require('./indexer');

//////////

const config = {};

if (args.config) {
  utils.merge(config, require(args.config));
} else {
  utils.merge(config, args);
}

//////////

const indexer = new Indexer(config);
indexer.start();
