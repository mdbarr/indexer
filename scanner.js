'use strict';

const fs = require('fs');
const async = require('async');
const { join } = require('path');
const { EventBus } = require('@metastack/events');

class Scanner extends EventBus {
  constructor ({
    pattern = /\.(asf|avi|divx|flv|mkv|mov|mpe?g|mp4|mts|m[14]v|ts|vob|webm|wmv|3gp)$/i,
    concurrency = 1, recursive = true, dotfiles = false, sort = false,
  } = {}) {
    super();

    this.stats = {
      directories: 0,
      files: 0,
    };

    this.seen = new Set();
    this.queue = async.queue((directory, next) => {
      this._running = true;

      if (this.seen.has(directory)) {
        return directory;
      }

      return fs.readdir(directory, { withFileTypes: true }, (error, entries) => {
        if (error) {
          return next(error);
        }

        this.seen.add(directory);
        this.stats.directories++;

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

        for (const entry of entries) {
          if (dotfiles === false && entry.name.startsWith('.')) {
            continue;
          }

          const path = join(directory, entry.name);

          if (entry.isDirectory() && recursive) {
            this.queue.push(path);
          } else if (entry.isFile() && !this.seen.has(path) &&
                     pattern.test(entry.name)) {
            this.seen.has(path);
            this.stats.files++;

            this.emit({
              type: 'file',
              data: {
                index: this.stats.files,
                path,
              },
            });
          }
        }

        return next();
      });
    }, concurrency);
  }

  add (directories) {
    if (Array.isArray(directories)) {
      directories.forEach((directory) => this.queue.push(directory));
    } else {
      this.queue.push(directories);
    }
  }

  clear () {
    if (this.queue.idle()) {
      this.seen.clear();
      this.stats.directories = 0;
      this.stats.files = 0;
      return true;
    }
    return false;
  }

  idle () {
    return this.queue.idle();
  }
}

module.exports = Scanner;
