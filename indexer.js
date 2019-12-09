'use strict';

require('barrkeep/pp');
const fs = require('fs');
const glob = require('glob');
const async = require('async');
const utils = require('barrkeep/utils');
const { execFile } = require('child_process');

const defaults = {
  cwd: process.cwd(),
  pattern: '**/*.{avi,flv,mkv,mp4,wmv}',
  concurrency: 1,
  hasher: '/usr/bin/sha1sum'
};

function Indexer (options = {}) {
  this.version = require('./package.json').version;
  this.config = utils.merge(defaults, options);

  this.queue = async.queue((file, callback) => {
    return fs.stat(file, (error, stat) => {
      if (error) {
        return callback(error);
      }

      return execFile(this.config.hasher, [ file ], (error, stdout) => {
        if (error) {
          return callback(error);
        }

        const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);
        const [ hash ] = stdout.trim().split(/\s+/);

        const original = {
          id: hash,
          path: file,
          name,
          extension,
          size: stat.size,
          timestamp: new Date(stat.mtime).getTime()
        };

        console.pp(original);
        return callback();
      });
    });
  }, this.config.concurrency);

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

      for (const file of files) {
        this.queue.push(file);
      }

      return files;
    });
  };
}

module.exports = Indexer;
