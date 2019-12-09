'use strict';

require('barrkeep/pp');
const glob = require('glob');
const utils = require('barrkeep/utils');

const defaults = {
  cwd: process.cwd(),
  pattern: '**/*.{avi,flv,mkv,mp4,wmv}'
};

function Indexer (options = {}) {
  this.version = require('./package.json').version;
  this.config = utils.merge(defaults, options);

  console.pp(this.config);

  this.scan = (callback) => {
    callback = utils.callback(callback);

    glob(this.config.pattern, {
      absolute: true,
      cwd: this.config.cwd,
      nodir: true
    }, (error, files) => {
      if (error) {
        return callback(error);
      }

      console.pp(files);

      return files;
    });
  };
}

module.exports = Indexer;
