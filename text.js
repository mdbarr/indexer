'use strict';

const { join } = require('node:path');
const fs = require('node:fs/promises');
const { brotli, execFile, gzip, md5sum } = require('./utils');
const SummarizerManager = require('node-summarizer').SummarizerManager;

class Text {
  constructor (indexer) {
    this.indexer = indexer;
    this.config = indexer.config.types.text;

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
    this.indexer.log.verbose(`examining ${ file }`);
    const stat = await fs.stat(file);

    return stat;
  }

  //////////

  async converter ({ file, slot }) {
    const skip = await this.common.skip(file);
    if (skip) {
      return;
    }

    const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);

    this.common.spinner(slot, '  Fingerprinting $name ', `${ name }.${ extension }`);

    this.indexer.log.verbose(`hashing ${ file }`);
    const { stdout: sha } = await execFile(this.config.shasum, [ file ]);

    const [ id ] = sha.trim().split(/\s+/);

    this.indexer.log.verbose(`hashed ${ file }: ${ id }`);

    const occurrence = {
      id,
      file,
      path: file.replace(/\/([^/]+)$/, '/'),
      name,
      extension,
    };

    for (let i = 0; i < this.indexer.slots.length; i++) {
      if (this.indexer.slots[i] && this.indexer.slots[i].index !== slot.index && this.indexer.slots[i].id === id) {
        this.indexer.log.verbose(`slot ${ i } is already processing ${ id }`);
        this.indexer.slots[i].occurrences.push(occurrence);
        return;
      }
    }

    slot.id = id;
    slot.occurrences = [ occurrence ];

    const item = await this.common.lookup(id);

    if (item) {
      this.indexer.log.verbose(`match for ${ id } found`);
      await this.common.duplicate(item, occurrence);
      return;
    }

    this.indexer.log.verbose(`no match for ${ id }`);
    const stat = await this.examine(file);

    slot.spinner.stop();

    if (stat.size < this.config.threshold) {
      this.indexer.log.verbose(`[text] ${ file } below threshold ${ stat.size }`);
      return;
    }

    this.common.spinner(slot, '  Processing and generating metadata for $name ', `${ name }.${ extension }`);

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

    this.indexer.log.verbose(`${ output }`);

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
        this.indexer.log.verbose(`match for converted ${ model.hash } found`);
        await this.common.duplicate(duplicate, occurrence);
        return;
      }
    }

    const sources = new Set(model.sources);
    sources.add(model.hash);
    model.sources = Array.from(sources);

    if (this.config.summarize > 0) {
      const normalized = text.replace(/[\r\n]/g, ' ').
        replace(/[^\x00-\x7F]/g, '').
        replace(/\s+/g, ' ').
        replace(/\.([A-Z])/g, '. $1').
        replace(/\.+/, '.');
      if (normalized) {
        const Summarizer = new SummarizerManager(normalized, this.config.summarize);
        const summary = await Summarizer.getSummaryByRank();
        if (typeof summary?.summary === 'string') {
          model.description = summary.summary.replace(/\.(["A-Z])/g, '. $1');
          this.indexer.log.verbose(`summary: ${ model.description }`);
        }
      }
    }

    if (!model.description) {
      model.description = text.trim().substr(0, this.config.summaryFallback);
    }

    model.contents = text;
    await this.common.tag(model);
    text = model.contents;

    await this.indexer.elastic.client.index({
      index: this.config.index,
      id: model.id,
      body: {
        name: model.name,
        description: model.description,
        contents: model.contents,
      },
    });
    await this.indexer.elastic.client.indices.refresh({ index: this.config.index });

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

    await this.common.delete(file);

    slot.spinner.stop();

    this.indexer.stats.text++;
    this.indexer.stats.converted++;

    this.indexer.log.info(`[text] indexed ${ file } -> ${ id }`);

    this.indexer.emit({
      type: 'indexed:text',
      data: model,
    });
  }
}

module.exports = Text;
