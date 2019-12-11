'use strict';

require('barrkeep/pp');
const fs = require('fs');
const os = require('os');
const glob = require('glob');
const async = require('async');
const uuid = require('uuid/v4');
const { join } = require('path');
const utils = require('barrkeep/utils');
const MongoClient = require('mongodb').MongoClient;
const {
  execFile, spawn
} = require('child_process');

const defaults = {
  cwd: process.cwd(),
  pattern: '**/*.{asf,avi,flv,mkv,mpg,mp4,m4v,wmv}',
  db: 'mongodb://localhost:27017/indexer',
  concurrency: 1,
  hasher: '/usr/bin/sha1sum',
  converter: 'ffmpeg -i $input -f $format -vcodec libx264 -preset fast' +
    ' -profile:v main -acodec aac $output -hide_banner',
  format: 'mp4',
  tmpdir: os.tmpdir()
};

function Indexer (options = {}) {
  this.version = require('./package.json').version;
  this.config = utils.merge(defaults, options);

  this.lookup = (hash, callback) => {
    return this.media.findOne({ hash }, callback);
  };

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
          hash,
          file,
          path: file.replace(/\/([^/]+)$/, '/'),
          name,
          extension,
          size: stat.size,
          timestamp: new Date(stat.mtime).getTime()
        };

        return this.lookup(hash, (error, item) => {
          if (error) {
            return callback(error);
          }

          if (item) { // found
            console.log(`  - match for ${ hash } found`);
            console.pp(original);
            return callback();
          } // convert
          const id = uuid();
          const output = join(this.config.tmpdir, `${ id }.${ this.config.format }`);

          const args = this.config.converter.
            trim().
            split(/\s+/).
            map((arg) => {
              return arg.replace('$input', file).
                replace('$output', output).
                replace('$format', this.config.format);
            });

          const command = args.shift();

          console.log(` * converting ${ name }.${ extension } ...`);

          const convert = spawn(command, args);

          // convert.stderr.on('data', (data) => {
          //   console.log(data.toString());
          // });

          // convert.stdout.on('data', (data) => {
          //   console.log(data.toString());
          // });

          convert.on('close', (code) => {
            if (code === 0) {
              console.log(` * converted ${ name }.${ extension }!`);
            } else {
              console.log(` ! failed to convert ${ name }.${ extension }`);
            }

            return callback();
          });

          return convert;
        });
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
