'use strict';

const fs = require('fs');
const async = require('async');
const { join } = require('path');
const { EventBus } = require('@metastack/events');

class Scanner extends EventBus {
  constructor ({
    pattern = /\.(asf|avi|flv|mkv|mpg|mp4|m4v|wmv|3gp)$/,
    concurrency = 1, recursive = true, dotfiles = false,
  } = {}) {
    super();

    const stats = {
      directories: 0,
      files: 0,
    };

    this.seen = new Set();
    this.queue = async.queue((directory, next) => {
      if (this.seen.has(directory)) {
        return directory;
      }

      return fs.readdir(directory, { withFileTypes: true }, (error, entries) => {
        if (error) {
          return next(error);
        }

        this.seen.add(directory);
        stats.directories++;

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
            stats.files++;

            this.emit({
              type: 'file',
              data: {
                index: stats.files,
                path,
              },
            });
          }
        }

        return next();
      });
    }, concurrency);

    this.queue.drain(() => {
      this.emit({
        type: 'done',
        data: stats,
      });
    });
  }

  add (directories) {
    if (Array.isArray(directories)) {
      directories.forEach((directory) => this.queue.push(directory));
    } else {
      this.queue.push(directories);
    }
  }
}

module.exports = Scanner;
