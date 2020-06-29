'use strict';

const fs = require('fs');
const async = require('async');
const { join } = require('path');
const anymatch = require('anymatch');
const { EventBus } = require('@metastack/events');

class Scanner extends EventBus {
  constructor ({
    files = /\.(asf|avi|divx|flv|mkv|mov|mpe?g|mp4|mts|m[14]v|ts|vob|webm|wmv|3gp)$/i,
    exclude, concurrency = 1, recursive = true, dotfiles = false, sort = false,
    maxDepth = 25, followSymlinks = true,
  } = {}, log) {
    super();

    this.log = log;
    this.seen = new Set();

    this.stats = {
      directories: 0,
      files: 0,
    };

    //////////

    this.queue = async.queue((data, done) => {
      const { directory, depth } = data;

      if (depth > maxDepth) {
        this.log.info(`scanner: skipping deep directory ${ directory }, depth ${ depth }`);
      }

      if (this.seen.has(directory)) {
        this.log.info(`scanner: skipping seen directory ${ directory }`);
        return done();
      }

      this.seen.add(directory);
      this.stats.directories++;

      this.log.info(`scanner: scanning ${ directory }`);
      return fs.readdir(directory, { withFileTypes: true }, (error, entries) => {
        if (error) {
          return done(error);
        }

        if (sort) {
          entries.sort((a, b) => {
            if (a.name < b.name) {
              return -1;
            } else if (a.name > b.name) {
              return 1;
            }
            return 0;
          });
        }

        return async.each(entries, (entry, next) => {
          const relative = join(directory, entry.name);

          if (dotfiles === false && entry.name.startsWith('.')) {
            this.log.verbose(`scanner: skipping dotfile ${ relative }`);
            return next();
          }

          if (entry.isSymbolicLink() && !followSymlinks) {
            this.log.verbose(`scanner: skipping symlink ${ relative }`);
            return next();
          }

          if (entry.isDirectory() && recursive || entry.isFile() && anymatch(files, entry.name)) {
            return fs.realpath(relative, (error, path) => {
              if (error) {
                return next(error);
              }

              if (this.seen.has(path)) {
                this.log.info(`scanner: skipping seen entry ${ path }`);
                return next();
              }

              if (exclude && anymatch(exclude, path)) {
                this.log.info(`scanner: excluding ${ path }`);
                return next();
              }

              if (entry.isDirectory()) {
                this.log.info(`scanner: queueing directory ${ path }`);
                this.queue.push({
                  directory: path,
                  depth: depth + 1,
                });
              } else if (entry.isFile()) {
                this.seen.add(path);
                this.stats.files++;

                this.emit({
                  type: 'file',
                  data: {
                    index: this.stats.files,
                    path,
                  },
                });
              }
              return next();
            });
          }
          return next();
        }, (error) => done(error));
      });
    }, concurrency);

    this.queue.error((error, data) => {
      this.log.error(`scanner: error scanning ${ data.directory }`);
      this.log.error(error.toString());
    });

    this.queue.drain(() => {
      this.log.info('scanner: done!');
    });
  }

  add (directories, depth = 0) {
    if (!Array.isArray(directories)) {
      directories = [ directories ];
    }

    for (const directory of directories) {
      this.log.info(`scanner: adding directory ${ directory }`);
      this.queue.push({
        directory,
        depth,
      });
    }
  }

  clear () {
    this.log.info('scanner: clearing history and queue');
    this.queue.remove(() => true);
    this.seen.clear();
    this.stats.directories = 0;
    this.stats.files = 0;
    return true;
  }

  idle () {
    return this.queue.idle();
  }
}

module.exports = Scanner;
