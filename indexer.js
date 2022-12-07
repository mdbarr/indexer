'use strict';

require('barrkeep/pp');

const async = require('async');
const logger = require('./logger');
const Scanner = require('./scanner');
const utils = require('barrkeep/utils');
const style = require('barrkeep/style');
const { ProgressBar } = require('barrkeep/progress');
const { EventBus } = require('@hyperingenuity/events');

const Image = require('./image');
const Text = require('./text');
const Video = require('./video');
const defaults = require('./defaults');

//////////

class Indexer extends EventBus {
  constructor (options = {}) {
    super();

    this.config = utils.merge(defaults, options);
    this.log = logger(this.config.logs);

    this.database = require('./database')(this, options);
    this.elastic = require('./elastic')(this, options);

    this.image = new Image(this);
    this.text = new Text(this);
    this.video = new Video(this);

    this.stats = {
      converted: 0,
      failed: 0,
      duplicates: 0,
      skipped: 0,
      images: 0,
      text: 0,
      videos: 0,
    };

    this.progressMax = Math.min(60, process.stdout.columns - 80);

    this.slots = new Array(this.config.concurrency);

    this.queue = async.queue(async ({ type, file }) => {
      const slot = {};

      for (let index = 0; index < this.slots.length; index++) {
        if (!this.slots[index]) {
          this.slots[index] = slot;
          slot.index = index;
          break;
        }
      }
      slot.y = 5 + slot.index * 2;

      try {
        switch (type) {
          case 'image':
            await this.image.converter({
              file,
              slot,
            });
            break;
          case 'text':
            await this.text.converter({
              file,
              slot,
            });
            break;
          case 'video':
            await this.video.converter({
              file,
              slot,
            });
            break;
        }
      } catch (error) {
        this.log.error(`[error] ${ type } ${ file }:`);
        this.log.error(error.stack.toString());
        this.stats.failed++;
      }

      this.slots[slot.index] = false;
      slot?.spinner?.stop();
      slot?.progress?.done();

      if (this.progress) {
        this.progress.value++;
        this.tokens.processed++;
      }
    }, this.config.concurrency);

    process.on('SIGINT', () => {
      console.log('\x1b[H\x1b[2J\x1b[?25hCanceled.');
      this.printStats();
      process.exit(0);
    });

    this.tokens = {
      left: style('[', 'fg: grey; style: bold'),
      right: style(']', 'fg: grey; style: bold'),
      files: 0,
      processed: 0,
    };
  }

  async scan () {
    this.log.info('scanning...');

    this.progress = new ProgressBar({
      format: ' Processed $processed/$files files $left$progress$right ' +
        '$percent ($eta remaining) $spinner',
      total: 1,
      width: this.progressMax,
      y: 3,
      complete: style('◼', 'fg: Green4'),
      head: false,
      spinner: 'dots',
      spinnerStyle: 'fg: DodgerBlue1',
      clear: true,
      tokens: this.tokens,
      formatOptions: { numeral: true },
    });

    this.seen = new Set();
    this.scanner = new Scanner({
      eventbus: this,
      log: this.log,
      ...this.config,
    });

    this.on('file:*', (event) => {
      if (!this.seen.has(event.data.path)) {
        this.seen.add(event.data.path);

        if (event.data.index !== 1) {
          this.progress.total++;
        }
        this.tokens.files++;
        this.queue.push({
          type: event.data.type,
          file: event.data.path,
        });
      }
    });

    this.scanner.add(this.config.scan);

    if (this.config.persistent && this.config.rescan > 0) {
      this.rescanner = setInterval(() => {
        this.scanner.clear();
        this.scanner.add(this.config.scan);
      }, this.config.rescan);
    }

    await this.queue.drain();

    if (!this.config.persistent) {
      if (this.rescanner) {
        clearInterval(this.rescanner);
      }
      if (this.progress) {
        this.progress.done();
      }
      console.log('\x1b[H\x1b[2J\x1b[?25hDone.');
      this.printStats();
    }
  }

  printStats () {
    console.log('  Converted:', utils.formatNumber(this.stats.converted, { numeral: true }));
    console.log('  Failed:', utils.formatNumber(this.stats.failed, { numeral: true }));
    console.log('  Duplicates:', utils.formatNumber(this.stats.duplicates, { numeral: true }));
    if (this.config.video.canSkip && !this.config.video.delete) {
      console.log('  Skipped:', utils.formatNumber(this.stats.skipped, { numeral: true }));
    }
  }

  async start () {
    console.log(`\x1b[H\x1b[2J\n${ this.config.name } starting up...`);

    await async.parallel([ this.database.start, this.elastic.start ]);
  }

  async stop () {
    await this.database.stop();
  }
}

module.exports = Indexer;
