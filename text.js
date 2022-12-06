'use strict';

const { join } = require('node:path');
const fs = require('node:fs/promises');
const { Spinner } = require('barrkeep/progress');
const { brotli, execFile, gzip, md5sum } = require('./utils');

class Text {
  constructor (indexer) {
    this.indexer = indexer;
    this.config = indexer.config.text;

    this.common = require('./common')(indexer, this.config);
    this.common.configure();
  }

  //////////

  model ({
    id, occurrence, occurrences, output, stat,
  }) {
    const sources = new Set([ id ]);
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
      object: 'text',
      version: this.indexer.config.version,
      name: occurrence.name,
      description: '',
      hash: null,
      sources: Array.from(sources),
      relative: output.replace(this.config.save, '').replace(/^\//, ''),
      size: stat.size,
      compression: this.config.compression,
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

  async examine (file) {
    this.indexer.log.info(`examining ${ file }`);
    const stat = await fs.stat(file);

    return stat;
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

    const scrollName = this.common.nameScroller(name, extension);

    let slow = 0;

    slot.spinner = new Spinner({
      prepend: scrollName('  Fingerprinting $name '),
      spinner: 'dots4',
      style: 'fg: DodgerBlue1',
      x: 0,
      y: slot.y,
    });

    slot.spinner.start();

    slot.spinner.onTick = () => {
      if (slow % 2 === 0) {
        slot.spinner.prepend = scrollName();
      }
      slow++;
    };

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
    const stat = await this.examine(file);

    slot.spinner.stop();
    slot.spinner.prepend = scrollName('  Processing and generating metadata for $name ');
    slot.spinner.start();

    occurrence.size = stat.size;
    occurrence.timestamp = new Date(stat.mtime).getTime();

    const directory = join(this.config.save, id.substring(0, 2));
    const filename = id.substring(2);

    let output = join(directory, `${ filename }.${ extension }`);
    if (this.config.compression === 'brotli') {
      output += '.br';
    } else if (this.config.compression === 'gzip') {
      output += '.gz';
    }

    await fs.mkdir(directory, { recursive: true });

    this.indexer.log.info(`${ output }`);

    const model = this.model({
      id,
      hash: id,
      occurrence,
      occurrences: slot.occurrences,
      output,
      stat,
    });

    let text = await fs.readFile(file);
    text = text.toString();

    if (typeof this.config.processor === 'function') {
      text = await this.config.processor(model, text);
    }

    model.hash = md5sum(text);

    if (model.hash !== model.id) {
      const duplicate = await this.common.lookup(model.hash);
      if (duplicate) {
        this.indexer.log.info(`match for converted ${ model.hash } found`);
        await this.common.duplicate(duplicate, occurrence);
        return;
      }
    }

    const sources = new Set(model.sources);
    sources.add(model.hash);
    model.sources = Array.from(sources);

    model.contents = text;
    await this.common.tag(model);
    text = model.contents;

    delete model.contents;

    let buffer = text;
    if (model.compression === 'brotli') {
      buffer = await brotli(text);
    } else if (model.compression === 'gzip') {
      buffer = await gzip(text);
    }

    await fs.writeFile(output, buffer);

    const details = await this.examine(output);
    model.size = details.size;

    await this.indexer.database.media.insertOne(model);

    slot.spinner.stop();

    this.indexer.stats.converted++;
  }
}

module.exports = Text;
