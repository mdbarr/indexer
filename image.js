'use strict';

const { join } = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('./utils');

class Image {
  constructor (indexer) {
    this.indexer = indexer;
    this.config = indexer.config.image;

    this.common = require('./common')(indexer, this.config);
    this.common.configure();
  }

  //////////

  model ({
    id, hash, occurrence, occurrences, output, stat,
    thumbnail, details,
  }) {
    const sources = new Set([ id, hash ]);
    if (occurrence) {
      sources.add(occurrence.id);
    }
    if (Array.isArray(occurrences)) {
      for (const item of occurrences) {
        sources.add(item.id);
      }
    }

    const timestamp = Date.now();

    const model = {
      id,
      object: 'image',
      version: this.indexer.config.version,
      name: occurrence.name,
      description: '',
      hash,
      sources: Array.from(sources),
      relative: output.replace(this.config.save, '').replace(/^\//, ''),
      thumbnail: thumbnail.replace(this.config.save, '').replace(/^\//, ''),
      size: stat.size,
      aspect: details.aspect,
      width: details.width,
      height: details.height,
      metadata: {
        created: new Date(stat.mtime).getTime(),
        added: timestamp,
        updated: timestamp,
        occurrences: occurrences || [ occurrence ],
        series: false,
        views: 0,
        stars: 0,
        favorited: false,
        reviewed: false,
        private: false,
        tags: [ ],
      },
      deleted: false,
    };

    return model;
  }

  //////////

  identifyParser (data, object) {
    const stack = [ object ];

    for (const line of data) {
      let [ key, value ] = line.split(/: /);
      const depth = key.replace(/^(\s+).*$/, '$1').length / 2 - 1;

      key = key.trim().toLowerCase().
        replace(/\s/g, '-').
        replace(/:$/, '');

      if (!value) {
        stack[depth][key] = {};
        stack[depth + 1] = stack[depth][key];
      } else {
        value = value.trim();

        if (value === 'True' || value === 'true') {
          value = true;
        } else if (value === 'False' || value === 'false') {
          value = false;
        } else if (value === 'Undefined' || value === 'undefined') {
          value = undefined;
        } else if (Number(value).toString() === value) {
          value = Number(value);
        }

        stack[depth][key] = value;

        if (key === 'geometry') {
          stack[depth].width = parseInt(value.replace(/^(\d+)x\d+\+.*$/, '$1'), 10);
          stack[depth].height = parseInt(value.replace(/^\d+x(\d+)\+.*$/, '$1'), 10);
          stack[depth].aspect = stack[depth].width / stack[depth].height;
        }
      }
    }
    return object;
  }

  async examine (file) {
    this.indexer.log.info(`examining ${ file }`);
    const stat = await fs.stat(file);

    this.indexer.log.info(`probing detailed information for ${ file }`);

    const { stdout } = await execFile(this.config.identify, [ '-verbose', file ]);
    const data = stdout.trim().split(/\n/);
    data.shift();

    const details = this.identifyParser(data, {});

    return [ stat, details ];
  }

  //////////

  async converter ({ file, slot }) {
    const skip = await this.common.skipFile(file);

    if (skip) {
      this.indexer.log.info(`skipping file due to existing entry ${ file }`);
      this.indexer.stats.skipped++;
      return;
    }

    const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);

    this.common.spinner(slot, '  Fingerprinting $name ', `${ name }.${ extension }`);

    this.indexer.log.info(`hashing ${ file }`);
    const { stdout: sha } = await execFile(this.config.shasum, [ file ]);

    const [ id ] = sha.trim().split(/\s+/);

    this.indexer.log.info(`hashed ${ file }: ${ id }`);

    const occurrence = {
      id,
      file,
      path: file.replace(/\/([^/]+)$/, '/'),
      name,
      extension,
    };

    for (let i = 0; i < this.indexer.slots.length; i++) {
      if (this.indexer.slots[i] && this.indexer.slots[i].index !== slot.index && this.indexer.slots[i].id === id) {
        this.indexer.log.info(`slot ${ i } is already processing ${ id }`);
        this.indexer.slots[i].occurrences.push(occurrence);
        return;
      }
    }

    slot.id = id;
    slot.occurrences = [ occurrence ];

    const item = await this.common.lookup(id);

    if (item) {
      this.indexer.log.info(`match for ${ id } found`);
      await this.duplicate(item, occurrence);
      return;
    }

    this.indexer.log.info(`no match for ${ id }`);
    const [ stat, details ] = await this.examine(file);
    if (!stat || !details) {
      return;
    }

    slot.spinner.stop();

    this.common.spinner(slot, '  Generating thumbnail and metadata for $name ', `${ name }.${ extension }`);

    occurrence.size = stat.size;
    occurrence.timestamp = new Date(stat.mtime).getTime();

    const directory = join(this.config.save, id.substring(0, 2));
    const filename = id.substring(2);

    const output = join(directory, `${ filename }.${ extension }`);
    const thumbnail = join(directory, `${ filename }p.${ this.config.thumbnail.format }`);

    await fs.mkdir(directory, { recursive: true });

    this.indexer.log.info(`${ output } - ${ thumbnail }`);

    await fs.copyFile(file, output);

    const thumbnailArgs = this.config.resize.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$thumbnail', thumbnail).
        replace('$input', output).
        replace('$geometry', `${ this.config.thumbnail.width }x${ this.config.thumbnail.height }`));

    this.indexer.log.info(`generating thumbnail ${ thumbnail }`);

    await execFile(this.config.convert, thumbnailArgs);
    this.indexer.log.info(`generated thumbnail ${ thumbnail }`);

    const model = this.model({
      id,
      hash: id,
      occurrence,
      occurrences: slot.occurrences,
      output,
      stat,
      thumbnail,
      details,
    });

    await this.common.tag(model);

    await this.indexer.database.media.insertOne(model);

    await this.common.delete(file);

    slot.spinner.stop();

    this.indexer.stats.images++;
    this.indexer.stats.converted++;
  }
}

module.exports = Image;
