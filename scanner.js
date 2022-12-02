'use strict';

const fs = require('fs/promises');
const async = require('async');
const { join } = require('path');
const logger = require('./logger');
const anymatch = require('anymatch');
const { EventBus } = require('@hyperingenuity/events');

class Scanner extends EventBus {
  constructor ({
    types, exclude, concurrency = 1, recursive = true, dotfiles = false,
    sort = false, maxDepth = 25, followSymlinks = true, logs,
  } = {}, log) {
    super();

    this.log = log || logger(logs);
    this.seen = new Set();

    this.stats = {
      directories: 0,
      files: 0,
    };

    //////////

    this.queue = async.queue(async (data) => {
      const { directory, depth } = data;

      if (depth > maxDepth) {
        this.log.info(`scanner: skipping deep directory ${ directory }, depth ${ depth }`);
      }

      if (this.seen.has(directory)) {
        this.log.info(`scanner: skipping seen directory ${ directory }`);
        return;
      }

      this.seen.add(directory);
      this.stats.directories++;

      this.log.info(`scanner: scanning ${ directory }`);
      const entries = await fs.readdir(directory, { withFileTypes: true });

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

      await async.each(entries, async (entry) => {
        if (dotfiles === false && entry.name.startsWith('.')) {
          this.log.verbose(`scanner: skipping dotfile ${ directory }/${ entry.name }`);
          return;
        }

        if (entry.isDirectory()) {
          if (!recursive) {
            this.log.verbose(`scanner: not recursivelt scanning ${ directory }/${ entry.name }`);
            return;
          }

          if (entry.isSymbolicLink() && !followSymlinks) {
            this.log.verbose(`scanner: skipping symlink ${ directory }/${ entry.name }`);
            return;
          }
        }

        const path = await this.realpath(directory, entry);
        if (this.seen.has(path)) {
          this.log.info(`scanner: skipping seen entry ${ path }`);
          return;
        }

        if (entry.isDirectory()) {
          if (exclude && anymatch(exclude, path)) {
            this.log.verbose(`scanner: excluding ${ path }`);
            return;
          }

          this.log.info(`scanner: queueing directory ${ path }`);
          this.queue.push({
            directory: path,
            depth: depth + 1,
          });
        } else if (entry.isFile()) {
          let kind = 'unknown';

          for (const type in types) {
            if (types[type].enabled && anymatch(types[type].pattern, path)) {
              kind = type;
              break;
            }
          }

          if (kind === 'unknown') {
            this.log.verbose(`scanner: excluding unknown type ${ path }`);
            return;
          }

          this.seen.add(path);
          this.stats.files++;

          this.emit({
            type: `file:${ kind }`,
            data: {
              index: this.stats.files,
              type: kind,
              path,
            },
          });
        }
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

  async add (directories, depth = 0) {
    if (!Array.isArray(directories)) {
      directories = [ directories ];
    }

    await async.each(directories, async (directory) => {
      const path = await fs.realpath(directory);

      this.log.info(`scanner: adding directory ${ directory }`);

      this.queue.push({
        directory: path,
        depth,
      });
    });
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

  async realpath (directory, entry) {
    const relative = join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      return await fs.realpath(relative);
    }
    return relative;
  }
}

module.exports = Scanner;
