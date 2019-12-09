'use strict';

require('barrkeep/pp');
const fs = require('fs');
const glob = require('glob');
const async = require('async');
const utils = require('barrkeep/utils');
const { execFile } = require('child_process');
const MongoClient = require('mongodb').MongoClient;

const defaults = {
  cwd: process.cwd(),
  pattern: '**/*.{avi,flv,mkv,mp4,wmv}',
  db: 'mongodb://localhost:27017/indexer',
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
    console.log(' - scanning...');
    return glob(this.config.pattern, {
      absolute: true,
      cwd: this.config.cwd,
      nodir: true
    }, (error, files) => {
      if (error) {
        return callback(error);
      }

      console.log(` - scan found ${ files.length } candidates.`);

      console.log(' - processing...');
      for (const file of files) {
        this.queue.push(file);
      }

      return this.queue.drain(() => {
        console.log('Done.');
        return callback();
      });
    });
  };

  this.start = (callback) => {
    callback = utils.callback(callback);

    console.log(`Indexer v${ this.version } starting up...`);

    this.client = new MongoClient(this.config.db, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log(` - connecting to ${ this.config.db }...`);
    return this.client.connect((error) => {
      if (error) {
        return callback(error);
      }

      this.db = this.client.db();
      this.media = this.db.collection('media');

      return this.scan((error) => {
        if (error) {
          return callback(error);
        }

        return this.client.close(callback);
      });
    });
  };
}

module.exports = Indexer;
